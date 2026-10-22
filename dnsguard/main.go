// qmanager_dnsguard — local DNS forwarder for QManager's DNS Privacy page.
// LAN DNS (port 53 on bridge0) is redirected here by an iptables nat rule; names on the block lists are answered with
// 0.0.0.0 / ::, everything else goes to an encrypted resolver (DNS over TLS) or the
// carrier's DNS. See docs/reference/dns-privacy.md.
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
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"sort"
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

type blockConfig struct {
	Enabled bool     `json:"enabled"`
	Lists   []string `json:"lists"`
	Allow   []string `json:"allow"`
	Deny    []string `json:"deny"`
}

type config struct {
	Encrypt encryptConfig `json:"encrypt"`
	Block   blockConfig   `json:"block"`
}

func (c config) fallback() bool { return c.Encrypt.Fallback == nil || *c.Encrypt.Fallback }

type listState struct {
	ID      string `json:"id"`
	Domains int    `json:"domains"`
	Updated int64  `json:"updated"`
	Error   string `json:"error,omitempty"`
}

type engine struct {
	cfg      atomic.Pointer[config]
	enc      atomic.Pointer[resolverBox]
	plain    *plainResolver
	blocked  atomic.Pointer[domainSet]
	allow    atomic.Pointer[domainSet]
	deny     atomic.Pointer[domainSet]
	roots    *x509.CertPool
	listDir  string
	statPath string
	started  time.Time

	queries, blockedN, encrypted, fallbackN, failed atomic.Uint64
	latencySum, latencyN                            atomic.Uint64

	mu          sync.Mutex
	lists       []listState
	topBlocked  map[string]uint64
	recent      []recentBlock
	upOK        int64
	upErr       string
	upErrAt     int64
	fallbackAt  int64
	loading     bool
	reloadAgain bool
	updating    bool

	localDNS func() string // LAN dnsmasq for local names; "" when unknown
}

type recentBlock struct {
	D string `json:"d"`
	T int64  `json:"t"`
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
	c.Block.Lists = []string{"hagezi_light"}
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
	e.allow.Store(newDomainSet(cleanDomains(c.Block.Allow)))
	e.deny.Store(newDomainSet(cleanDomains(c.Block.Deny)))
	go e.loadLists()
}

func cleanDomains(in []string) []string {
	var out []string
	for _, s := range in {
		if d := normalizeDomain(s); d != "" {
			out = append(out, d)
		}
	}
	return out
}

func (e *engine) listPath(id string) string { return filepath.Join(e.listDir, id+".txt") }

// loadLists rebuilds the merged block set from the downloaded files.
func (e *engine) loadLists() {
	e.mu.Lock()
	if e.loading {
		e.reloadAgain = true
		e.mu.Unlock()
		return
	}
	e.loading = true
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		again := e.reloadAgain
		e.loading, e.reloadAgain = false, false
		e.mu.Unlock()
		if again {
			e.loadLists()
		}
	}()

	c := e.cfg.Load()
	e.pruneLists(c)
	if !c.Block.Enabled {
		e.blocked.Store(nil)
		e.mu.Lock()
		e.lists = nil
		e.mu.Unlock()
		debug.FreeOSMemory()
		return
	}
	var all []string
	states := make([]listState, 0, len(c.Block.Lists))
	for _, id := range c.Block.Lists {
		st := listState{ID: id}
		if _, ok := catalog[id]; !ok {
			st.Error = "unknown list"
			states = append(states, st)
			continue
		}
		p := e.listPath(id)
		if fi, err := os.Stat(p); err == nil {
			st.Updated = fi.ModTime().Unix()
			var n int
			all, n, _ = readListFile(p, all, maxDomains)
			st.Domains = n
			if len(all) >= maxDomains {
				st.Error = "too_many"
			}
		} else {
			st.Error = "not_downloaded"
		}
		states = append(states, e.keepError(st))
	}
	set := newDomainSet(all)
	all = nil
	e.blocked.Store(set)
	e.mu.Lock()
	e.lists = states
	e.mu.Unlock()
	debug.FreeOSMemory()
	log.Printf("block lists loaded: %d names", set.len())
}

// pruneLists deletes downloaded lists that are no longer selected, to give the flash back.
func (e *engine) pruneLists(c *config) {
	keep := map[string]bool{}
	if c.Block.Enabled {
		for _, id := range c.Block.Lists {
			keep[id+".txt"] = true
		}
	}
	entries, _ := os.ReadDir(e.listDir)
	for _, de := range entries {
		if n := de.Name(); !de.IsDir() && !keep[n] && (strings.HasSuffix(n, ".txt") || strings.HasSuffix(n, ".part")) {
			os.Remove(filepath.Join(e.listDir, n))
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

// keepError carries a recent download error over a reload.
func (e *engine) keepError(st listState) listState {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, old := range e.lists {
		if old.ID == st.ID && old.Error != "" && old.Error != "not_downloaded" && st.Error == "" {
			if old.Updated == st.Updated {
				st.Error = old.Error
			}
		}
	}
	return st
}

func (e *engine) setListError(id, msg string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for i := range e.lists {
		if e.lists[i].ID == id {
			e.lists[i].Error = msg
			return
		}
	}
	e.lists = append(e.lists, listState{ID: id, Error: msg})
}

// updateLists downloads lists that are missing, or all of them when forced.
func (e *engine) updateLists(force bool) {
	c := e.cfg.Load()
	if !c.Block.Enabled || !clockSane() {
		return
	}
	e.mu.Lock()
	if e.updating {
		e.mu.Unlock()
		return
	}
	e.updating = true
	e.mu.Unlock()
	defer func() { e.mu.Lock(); e.updating = false; e.mu.Unlock() }()

	changed := false
	for _, id := range c.Block.Lists {
		spec, ok := catalog[id]
		if !ok {
			continue
		}
		p := e.listPath(id)
		if fi, err := os.Stat(p); err == nil && !force && time.Since(fi.ModTime()) < 24*time.Hour {
			continue
		}
		if err := e.download(spec.URL, p); err != nil {
			log.Printf("list %s: %v", id, err)
			e.setListError(id, "download_failed")
			continue
		}
		changed = true
	}
	if changed {
		e.loadLists()
	}
}

// curlPath: downloads go through the system curl so the daemon carries no HTTP stack.
var curlPath = "curl"

func (e *engine) download(url, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := dest + ".part"
	cmd := exec.Command(curlPath, "-fsSL", "--max-time", "120", "--max-filesize", "33554432", "-o", tmp, url)
	out, err := cmd.CombinedOutput()
	if err != nil {
		os.Remove(tmp)
		return fmt.Errorf("curl: %v %s", err, strings.TrimSpace(string(out)))
	}
	if fi, serr := os.Stat(tmp); serr != nil || fi.Size() < 64 {
		err = fmt.Errorf("list is empty")
	}
	if err == nil {
		// A list must parse to at least one name before it replaces the old copy.
		var got int
		_, got, _ = readListFile(tmp, nil, 1)
		if got == 0 {
			err = fmt.Errorf("list has no domains")
		}
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dest)
}

func (e *engine) setUpstreamError(msg string) {
	e.mu.Lock()
	e.upErr, e.upErrAt = msg, time.Now().Unix()
	e.mu.Unlock()
}

func (e *engine) noteBlocked(name string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.topBlocked[name]; ok || len(e.topBlocked) < 3000 {
		e.topBlocked[name]++
	}
	e.recent = append(e.recent, recentBlock{name, time.Now().Unix()})
	if len(e.recent) > 60 {
		e.recent = e.recent[len(e.recent)-50:]
	}
}

func (e *engine) isBlocked(name string) bool {
	c := e.cfg.Load()
	if !c.Block.Enabled || name == "" {
		return false
	}
	if _, ok := e.allow.Load().match(name); ok {
		return false
	}
	if _, ok := e.deny.Load().match(name); ok {
		return true
	}
	_, ok := e.blocked.Load().match(name)
	return ok
}

// handle answers one query; maxUDP is 0 for TCP.
func (e *engine) handle(msg []byte, maxUDP int) []byte {
	q, err := parseQuery(msg)
	if err != nil {
		return nil
	}
	e.queries.Add(1)
	if q.single && e.isBlocked(q.name) {
		e.blockedN.Add(1)
		e.noteBlocked(q.name)
		return blockedReply(msg, q)
	}
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
		ifc, err := net.InterfaceByName(ifname)
		if err != nil {
			return ""
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil && ipn.IP.IsPrivate() {
				cached = net.JoinHostPort(ipn.IP.String(), "53")
				break
			}
		}
		return cached
	}
}

// --- listeners

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

type topEntry struct {
	D string `json:"d"`
	N uint64 `json:"n"`
}

func (e *engine) writeStatus() {
	c := e.cfg.Load()
	e.mu.Lock()
	top := make([]topEntry, 0, len(e.topBlocked))
	for d, n := range e.topBlocked {
		top = append(top, topEntry{d, n})
	}
	recent := make([]recentBlock, len(e.recent))
	copy(recent, e.recent)
	lists := make([]listState, len(e.lists))
	copy(lists, e.lists)
	upOK, upErr, upErrAt, fbAt, loading, updating := e.upOK, e.upErr, e.upErrAt, e.fallbackAt, e.loading, e.updating
	e.mu.Unlock()
	sort.Slice(top, func(i, j int) bool { return top[i].N > top[j].N || top[i].N == top[j].N && top[i].D < top[j].D })
	if len(top) > 10 {
		top = top[:10]
	}
	for i, j := 0, len(recent)-1; i < j; i, j = i+1, j-1 {
		recent[i], recent[j] = recent[j], recent[i]
	}
	if len(recent) > 20 {
		recent = recent[:20]
	}
	kind := "plain"
	if b := e.enc.Load(); b != nil && c.Encrypt.Enabled {
		kind = b.kind
	}
	var avg uint64
	if n := e.latencyN.Load(); n > 0 {
		avg = e.latencySum.Load() / n
	}
	st := map[string]any{
		"running":  true,
		"pid":      os.Getpid(),
		"started":  e.started.Unix(),
		"updated":  time.Now().Unix(),
		"clock_ok": clockSane(),
		"mem_kb":   rssKB(),
		"mode":     map[string]bool{"encrypt": c.Encrypt.Enabled, "block": c.Block.Enabled},
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
			"blocked":   e.blockedN.Load(),
			"encrypted": e.encrypted.Load(),
			"fallback":  e.fallbackN.Load(),
			"failed":    e.failed.Load(),
		},
		"domains_total":  e.blocked.Load().len(),
		"lists":          lists,
		"lists_loading":  loading,
		"lists_updating": updating,
		"top_blocked":    top,
		"recent_blocked": recent,
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
	listen := flag.String("listen", ":5335", "address the LAN redirect points at (the firewall keeps the cellular side out)")
	localDNS := flag.String("local-dns", "auto", "dnsmasq for LAN host names: host:port, auto (private IPv4 of -lan-if) or off")
	lanIf := flag.String("lan-if", "bridge0", "LAN interface for -local-dns auto")
	listDir := flag.String("lists", "/usrdata/qmanager/dnsguard", "downloaded block lists")
	statPath := flag.String("status", "/tmp/qmanager_dnsguard.json", "status file")
	reloadFlag := flag.String("reload-flag", "/tmp/qmanager_dnsguard_reload", "touch to reload settings")
	updateFlag := flag.String("update-flag", "/tmp/qmanager_dnsguard_update", "touch to re-download lists")
	resolvFiles := flag.String("resolv", "/run/resolv.conf,/etc/resolv.conf", "carrier resolver files, first with entries wins")
	extraCA := flag.String("ca", "", "extra PEM roots (testing)")
	allowLocal := flag.Bool("allow-local-resolvers", false, "accept loopback carrier resolvers (testing)")
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("dnsguard: ")

	debug.SetGCPercent(50)
	debug.SetMemoryLimit(32 << 20)

	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(embeddedRoots) {
		log.Fatal("no CA roots")
	}
	if *extraCA != "" {
		if pem, err := os.ReadFile(*extraCA); err == nil {
			roots.AppendCertsFromPEM(pem)
		}
	}
	for _, c := range []string{"/opt/bin/curl", "/usr/bin/curl"} {
		if _, err := os.Stat(c); err == nil {
			curlPath = c
			break
		}
	}

	e := &engine{
		plain:      &plainResolver{files: strings.Split(*resolvFiles, ","), allowLocal: *allowLocal},
		roots:      roots,
		listDir:    *listDir,
		statPath:   *statPath,
		started:    time.Now(),
		topBlocked: map[string]uint64{},
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

	pc, err := net.ListenPacket("udp", *listen)
	if err != nil {
		log.Fatalf("listen udp %s: %v", *listen, err)
	}
	tl, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatalf("listen tcp %s: %v", *listen, err)
	}
	go e.serveUDP(pc)
	go e.serveTCP(tl)
	log.Printf("listening on %s", *listen)

	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	term := make(chan os.Signal, 1)
	signal.Notify(term, syscall.SIGTERM, syscall.SIGINT)

	go e.updateLists(false)
	e.writeStatus()
	tick := time.NewTicker(2 * time.Second)
	lastStatus, lastUpdateCheck := time.Now(), time.Now()
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
				go e.updateLists(false)
				e.writeStatus()
			}
			if takeFlag(*updateFlag) {
				go func() { e.updateLists(true); e.writeStatus() }()
				e.writeStatus()
			}
			if time.Since(lastUpdateCheck) > 10*time.Minute {
				lastUpdateCheck = time.Now()
				go e.updateLists(false)
			}
			if time.Since(lastStatus) >= 5*time.Second {
				lastStatus = time.Now()
				e.writeStatus()
			}
		}
	}
}
