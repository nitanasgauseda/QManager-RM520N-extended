// qmanager_dnsguard — local DNS forwarder for QManager's DNS Privacy page.
// LAN DNS (port 53 on bridge0) is redirected here by an iptables nat rule and sent to an
// encrypted resolver (DNS over TLS) or the carrier's DNS. See docs/reference/dns-privacy.md.
package main

import (
	"context"
	"crypto/x509"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

//go:embed cacert.pem
var embeddedRoots []byte

// saneEpoch: before this the modem clock is still at 1970 and no certificate can verify.
const saneEpoch = 1700000000

type encryptConfig struct {
	Enabled    bool   `json:"enabled"`
	Provider   string `json:"provider"`
	Protocol   string `json:"protocol"`
	Fallback   *bool  `json:"fallback"`
	NextDNSID  string `json:"nextdns_id"`
	CustomHost string `json:"custom_host"`
	CustomIP   string `json:"custom_ip"`
}

type config struct {
	Encrypt encryptConfig `json:"encrypt"`
}

func (c config) fallback() bool { return c.Encrypt.Fallback == nil || *c.Encrypt.Fallback }

type engine struct {
	cfg      atomic.Pointer[config]
	enc      atomic.Pointer[resolverBox]
	plain    *plainResolver
	roots    *x509.CertPool
	statPath string
	started  time.Time

	queries, encrypted, fallbackN, failed atomic.Uint64
	latencySum, latencyN                  atomic.Uint64

	mu         sync.Mutex
	upOK       int64
	upErr      string
	upErrAt    int64
	fallbackAt int64

	localDNS  func() string // LAN dnsmasq for local names; "" when unknown
	listening []string
}

type resolverBox struct {
	r     resolver
	kind  string
	close func()
}

func clockSane() bool { return time.Now().Unix() >= saneEpoch }

func loadConfig(path string) config {
	var c config
	c.Encrypt.Provider, c.Encrypt.Protocol = "quad9", "dot"
	b, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(b, &c); err != nil {
			log.Printf("config: %v", err)
		}
	}
	return c
}

func (e *engine) applyConfig(c config) {
	e.cfg.Store(&c)
	if old := e.enc.Swap(nil); old != nil && old.close != nil {
		old.close()
	}
	if c.Encrypt.Enabled {
		p, err := providerFor(c.Encrypt)
		if err != nil {
			e.setUpstreamError(err.Error())
		} else {
			r := newDoT(p, e.roots)
			e.enc.Store(&resolverBox{r: r, kind: "dot", close: r.close})
		}
	}
}

// rssKB reads the process's resident memory, the number that matters on a 178 MB modem.
func rssKB() int {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			var kb int
			fmt.Sscanf(strings.TrimSpace(strings.TrimPrefix(line, "VmRSS:")), "%d", &kb)
			return kb
		}
	}
	return 0
}

func (e *engine) setUpstreamError(msg string) {
	e.mu.Lock()
	e.upErr, e.upErrAt = msg, time.Now().Unix()
	e.mu.Unlock()
}

// handle answers one query; maxUDP is 0 for TCP.
func (e *engine) handle(msg []byte, maxUDP int) []byte {
	q, err := parseQuery(msg)
	if err != nil {
		return nil
	}
	e.queries.Add(1)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	// Host names of LAN devices and reverse lookups of private addresses are dnsmasq's to answer.
	if q.single && isLocalName(q.name) && e.localDNS != nil {
		if a := e.localDNS(); a != "" {
			lctx, lcancel := context.WithTimeout(ctx, 2*time.Second)
			resp, err := udpExchange(lctx, a, msg)
			lcancel()
			if err == nil {
				return resp
			}
		}
	}
	start := time.Now()
	resp, err := e.forward(ctx, msg)
	if err != nil {
		e.failed.Add(1)
		return failReply(msg, q)
	}
	e.latencySum.Add(uint64(time.Since(start).Milliseconds()))
	e.latencyN.Add(1)
	if maxUDP > 0 {
		lim := q.udpSize
		if lim > maxUDP {
			lim = maxUDP
		}
		resp = fitUDP(resp, q, lim)
	}
	return resp
}

func (e *engine) forward(ctx context.Context, msg []byte) ([]byte, error) {
	c := e.cfg.Load()
	if c.Encrypt.Enabled {
		box := e.enc.Load()
		var err error
		if box == nil {
			err = fmt.Errorf("encrypted resolver not configured")
		} else if !clockSane() {
			err = fmt.Errorf("clock_not_set")
		} else {
			var resp []byte
			if resp, err = box.r.exchange(ctx, msg); err == nil {
				e.encrypted.Add(1)
				e.mu.Lock()
				e.upOK = time.Now().Unix()
				e.mu.Unlock()
				return resp, nil
			}
		}
		e.setUpstreamError(err.Error())
		if !c.fallback() {
			return nil, err
		}
		e.fallbackN.Add(1)
		e.mu.Lock()
		e.fallbackAt = time.Now().Unix()
		e.mu.Unlock()
		pctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		return e.plain.exchange(pctx, msg)
	}
	return e.plain.exchange(ctx, msg)
}

// isLocalName: single-label names, LAN suffixes and PTR names of private IPv4 ranges.
func isLocalName(n string) bool {
	if n == "" {
		return false
	}
	if !strings.Contains(n, ".") {
		return true
	}
	for _, suf := range []string{".lan", ".localdomain", ".home.arpa", ".internal"} {
		if strings.HasSuffix(n, suf) {
			return true
		}
	}
	if !strings.HasSuffix(n, ".in-addr.arpa") {
		return false
	}
	if strings.HasSuffix(n, ".10.in-addr.arpa") || n == "10.in-addr.arpa" ||
		strings.HasSuffix(n, ".168.192.in-addr.arpa") || strings.HasSuffix(n, ".254.169.in-addr.arpa") {
		return true
	}
	for i := 16; i <= 31; i++ {
		if strings.HasSuffix(n, "."+strconv.Itoa(i)+".172.in-addr.arpa") {
			return true
		}
	}
	return false
}

// lanDNS finds the LAN address dnsmasq listens on: the first private IPv4 of the LAN interface.
func lanDNS(ifname string) func() string {
	var mu sync.Mutex
	var at time.Time
	var cached string
	return func() string {
		mu.Lock()
		defer mu.Unlock()
		if time.Since(at) < time.Minute {
			return cached
		}
		at, cached = time.Now(), ""
		if ip := lanIPv4(ifname); ip != "" {
			cached = net.JoinHostPort(ip, "53")
		}
		return cached
	}
}

// --- listeners

func (e *engine) listenOn(addr string) error {
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	tl, err := net.Listen("tcp", addr)
	if err != nil {
		pc.Close()
		return err
	}
	go e.serveUDP(pc)
	go e.serveTCP(tl)
	e.mu.Lock()
	e.listening = append(e.listening, addr)
	e.mu.Unlock()
	log.Printf("listening on %s", addr)
	return nil
}

// listenLAN binds the private IPv4 of the LAN interface once it exists (QCMAP may bring bridge0 up late).
func (e *engine) listenLAN(ifname, port string) {
	for {
		if ip := lanIPv4(ifname); ip != "" {
			if err := e.listenOn(net.JoinHostPort(ip, port)); err == nil {
				return
			} else {
				log.Printf("listen lan %s: %v", ip, err)
			}
		}
		time.Sleep(3 * time.Second)
	}
}

func lanIPv4(ifname string) string {
	ifc, err := net.InterfaceByName(ifname)
	if err != nil {
		return ""
	}
	addrs, _ := ifc.Addrs()
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil && ipn.IP.IsPrivate() {
			return ipn.IP.String()
		}
	}
	return ""
}

func (e *engine) serveUDP(pc net.PacketConn) {
	sem := make(chan struct{}, 64)
	buf := make([]byte, 4096)
	for {
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			log.Printf("udp: %v", err)
			return
		}
		msg := append([]byte(nil), buf[:n]...)
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()
			if resp := e.handle(msg, 4096); resp != nil {
				pc.WriteTo(resp, addr)
			}
		}()
	}
}

func (e *engine) serveTCP(l net.Listener) {
	for {
		c, err := l.Accept()
		if err != nil {
			log.Printf("tcp: %v", err)
			time.Sleep(200 * time.Millisecond)
			continue
		}
		go func() {
			defer c.Close()
			for {
				c.SetDeadline(time.Now().Add(15 * time.Second))
				var lb [2]byte
				if _, err := io.ReadFull(c, lb[:]); err != nil {
					return
				}
				msg := make([]byte, binary.BigEndian.Uint16(lb[:]))
				if _, err := io.ReadFull(c, msg); err != nil {
					return
				}
				resp := e.handle(msg, 0)
				if resp == nil {
					return
				}
				out := make([]byte, 2+len(resp))
				binary.BigEndian.PutUint16(out, uint16(len(resp)))
				copy(out[2:], resp)
				if _, err := c.Write(out); err != nil {
					return
				}
			}
		}()
	}
}

// --- status file read by the CGI

func (e *engine) writeStatus() {
	c := e.cfg.Load()
	e.mu.Lock()
	upOK, upErr, upErrAt, fbAt := e.upOK, e.upErr, e.upErrAt, e.fallbackAt
	listening := append([]string(nil), e.listening...)
	e.mu.Unlock()
	kind := "plain"
	if b := e.enc.Load(); b != nil && c.Encrypt.Enabled {
		kind = b.kind
	}
	var avg uint64
	if n := e.latencyN.Load(); n > 0 {
		avg = e.latencySum.Load() / n
	}
	st := map[string]any{
		"listening": listening,
		"running":   true,
		"pid":       os.Getpid(),
		"started":   e.started.Unix(),
		"updated":   time.Now().Unix(),
		"clock_ok":  clockSane(),
		"mem_kb":    rssKB(),
		"mode":      map[string]bool{"encrypt": c.Encrypt.Enabled},
		"upstream": map[string]any{
			"kind":          kind,
			"provider":      c.Encrypt.Provider,
			"last_ok":       upOK,
			"last_error":    upErr,
			"last_error_at": upErrAt,
			"fallback_at":   fbAt,
			"avg_ms":        avg,
			"carrier":       e.plain.servers(),
		},
		"stats": map[string]uint64{
			"queries":   e.queries.Load(),
			"encrypted": e.encrypted.Load(),
			"fallback":  e.fallbackN.Load(),
			"failed":    e.failed.Load(),
		},
	}
	b, _ := json.Marshal(st)
	tmp := e.statPath + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		os.Rename(tmp, e.statPath)
	}
}

func takeFlag(path string) bool {
	if _, err := os.Stat(path); err != nil {
		return false
	}
	os.Remove(path)
	return true
}

func main() {
	cfgPath := flag.String("config", "/etc/qmanager/dnsguard.json", "settings file")
	listen := flag.String("listen", "127.0.0.1:5335,lan:5335", "addresses to listen on; lan:PORT is the private IPv4 of -lan-if")
	localDNS := flag.String("local-dns", "auto", "dnsmasq for LAN host names: host:port, auto (private IPv4 of -lan-if) or off")
	lanIf := flag.String("lan-if", "bridge0", "LAN interface for -local-dns auto")
	statPath := flag.String("status", "/tmp/qmanager_dnsguard.json", "status file")
	reloadFlag := flag.String("reload-flag", "/tmp/qmanager_dnsguard_reload", "touch to reload settings")
	resolvFiles := flag.String("resolv", "/run/resolv.conf,/etc/resolv.conf", "carrier resolver files, first with entries wins")
	extraCA := flag.String("ca", "", "extra PEM roots (testing)")
	allowLocal := flag.Bool("allow-local-resolvers", false, "accept loopback carrier resolvers (testing)")
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("dnsguard: ")

	debug.SetGCPercent(50)
	debug.SetMemoryLimit(16 << 20)

	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(embeddedRoots) {
		log.Fatal("no CA roots")
	}
	if *extraCA != "" {
		if pem, err := os.ReadFile(*extraCA); err == nil {
			roots.AppendCertsFromPEM(pem)
		}
	}
	e := &engine{
		plain:    &plainResolver{files: strings.Split(*resolvFiles, ","), allowLocal: *allowLocal},
		roots:    roots,
		statPath: *statPath,
		started:  time.Now(),
	}
	switch *localDNS {
	case "off", "":
	case "auto":
		e.localDNS = lanDNS(*lanIf)
	default:
		a := *localDNS
		e.localDNS = func() string { return a }
	}
	e.applyConfig(loadConfig(*cfgPath))

	// Bound to specific addresses, never the wildcard: a wildcard UDP socket answers from whatever
	// source the route picks, which in IP Passthrough mode is the carrier IP, and the router drops it.
	for _, a := range strings.Split(*listen, ",") {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		if strings.HasPrefix(a, "lan:") {
			go e.listenLAN(*lanIf, strings.TrimPrefix(a, "lan:"))
			continue
		}
		if err := e.listenOn(a); err != nil {
			log.Fatalf("listen %s: %v", a, err)
		}
	}

	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	term := make(chan os.Signal, 1)
	signal.Notify(term, syscall.SIGTERM, syscall.SIGINT)

	e.writeStatus()
	tick := time.NewTicker(2 * time.Second)
	lastStatus := time.Now()
	for {
		select {
		case <-term:
			os.Remove(*statPath)
			return
		case <-hup:
			e.applyConfig(loadConfig(*cfgPath))
			e.writeStatus()
		case <-tick.C:
			if takeFlag(*reloadFlag) {
				e.applyConfig(loadConfig(*cfgPath))
				e.writeStatus()
			}
			if time.Since(lastStatus) >= 5*time.Second {
				lastStatus = time.Now()
				e.writeStatus()
			}
		}
	}
}
