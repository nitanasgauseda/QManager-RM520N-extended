package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func buildQuery(id uint16, name string, qtype uint16, edns int) []byte {
	b := make([]byte, 12)
	binary.BigEndian.PutUint16(b[0:2], id)
	b[2] = 0x01 // RD
	binary.BigEndian.PutUint16(b[4:6], 1)
	for _, l := range strings.Split(name, ".") {
		b = append(b, byte(len(l)))
		b = append(b, l...)
	}
	b = append(b, 0, byte(qtype>>8), byte(qtype), 0, 1)
	if edns > 0 {
		binary.BigEndian.PutUint16(b[10:12], 1)
		b = append(b, 0, 0, 41, byte(edns>>8), byte(edns), 0, 0, 0, 0, 0, 0)
	}
	return b
}

// answer builds a response with n A records of 1.2.3.4 so size can be controlled.
func answer(q []byte, n int) []byte {
	pq, _ := parseQuery(q)
	out := append(header(q, 0, uint16(n)), q[12:pq.qend]...)
	for i := 0; i < n; i++ {
		out = append(out, 0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, byte(i))
	}
	return out
}

func TestParseQuery(t *testing.T) {
	q, err := parseQuery(buildQuery(7, "WWW.Example.COM", typeAAAA, 1232))
	if err != nil || !q.single || q.name != "www.example.com" || q.qtype != typeAAAA || q.udpSize != 1232 || q.id != 7 {
		t.Fatalf("got %+v %v", q, err)
	}
	if _, err := parseQuery([]byte{1, 2, 3}); err == nil {
		t.Fatal("short message accepted")
	}
	resp := answer(buildQuery(1, "a.b", typeA, 0), 1)
	if _, err := parseQuery(resp); err == nil {
		t.Fatal("response accepted as a query")
	}
}

func TestFitUDP(t *testing.T) {
	m := buildQuery(9, "big.example", typeA, 0)
	q, _ := parseQuery(m)
	big := answer(m, 60)
	small := fitUDP(big, q, 512)
	if len(small) > 512 || small[2]&0x02 == 0 || binary.BigEndian.Uint16(small[6:8]) != 0 {
		t.Fatalf("not truncated: %d bytes", len(small))
	}
	if r := fitUDP(answer(m, 2), q, 512); r[2]&0x02 != 0 {
		t.Fatal("small reply truncated")
	}
}

// --- test upstreams

type testCA struct {
	pool *x509.CertPool
	cert tls.Certificate
	pem  []byte
}

func newTestCA(t *testing.T, host string) testCA {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: host}, DNSNames: []string{host},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(c)
	return testCA{pool: pool, cert: tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}}
}

// dotServer answers every query with one A record; counts queries.
func dotServer(t *testing.T, ca testCA) (string, *int) { return dotServerOpts(t, ca, false) }

// dotServerOpts with oneShot closes each connection after one answer, like an idle timeout.
func dotServerOpts(t *testing.T, ca testCA, oneShot bool) (string, *int) {
	l, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{ca.cert}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	n := new(int)
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				for {
					var lb [2]byte
					if _, err := io.ReadFull(c, lb[:]); err != nil {
						return
					}
					m := make([]byte, binary.BigEndian.Uint16(lb[:]))
					if _, err := io.ReadFull(c, m); err != nil {
						return
					}
					*n++
					r := answer(m, 1)
					out := append([]byte{byte(len(r) >> 8), byte(len(r))}, r...)
					c.Write(out)
					if oneShot {
						return
					}
				}
			}()
		}
	}()
	return l.Addr().String(), n
}

// plainServer is a UDP "carrier" resolver answering with n records.
func plainServer(t *testing.T, records int) string {
	pc, err := net.ListenPacket("udp", "127.0.0.2:0")
	if err != nil {
		pc, err = net.ListenPacket("udp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { pc.Close() })
	go func() {
		buf := make([]byte, 4096)
		for {
			n, a, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			pc.WriteTo(answer(buf[:n], records), a)
		}
	}()
	return pc.LocalAddr().String()
}

func TestDoTExchange(t *testing.T) {
	ca := newTestCA(t, "dns.test")
	addr, n := dotServer(t, ca)
	r := &dotResolver{host: "dns.test", addrs: []string{addr}, conf: &tls.Config{ServerName: "dns.test", RootCAs: ca.pool}}
	for i := 0; i < 3; i++ {
		m := buildQuery(uint16(100+i), "example.com", typeA, 0)
		resp, err := r.exchange(context.Background(), m)
		if err != nil || resp[0] != m[0] || resp[1] != m[1] {
			t.Fatalf("exchange %d: %v", i, err)
		}
	}
	if *n != 3 || len(r.idle) != 1 {
		t.Fatalf("queries %d idle %d (connection should be reused)", *n, len(r.idle))
	}
	// Wrong certificate name must fail.
	bad := &dotResolver{host: "other.test", addrs: []string{addr}, conf: &tls.Config{ServerName: "other.test", RootCAs: ca.pool}}
	if _, err := bad.exchange(context.Background(), buildQuery(1, "a.com", typeA, 0)); err == nil {
		t.Fatal("certificate for another name accepted")
	}
}

func newTestEngine(t *testing.T, cfg config, resolvFile string) *engine {
	dir := t.TempDir()
	e := &engine{
		plain:    &plainResolver{files: []string{resolvFile}},
		roots:    x509.NewCertPool(),
		statPath: filepath.Join(dir, "status.json"),
		started:  time.Now(),
	}
	e.cfg.Store(&cfg)
	return e
}

func writeResolv(t *testing.T, addr string) string {
	host, port, _ := net.SplitHostPort(addr)
	p := filepath.Join(t.TempDir(), "resolv.conf")
	os.WriteFile(p, []byte("nameserver 127.0.0.1\nnameserver "+host+"\n"), 0o644)
	_ = port
	return p
}

func TestEngineFallback(t *testing.T) {
	carrier := plainServer(t, 1)
	host, port, _ := net.SplitHostPort(carrier)
	resolv := filepath.Join(t.TempDir(), "resolv.conf")
	os.WriteFile(resolv, []byte("nameserver "+host+"\n"), 0o644)
	if port != "53" {
		// The plain resolver always uses port 53; exercise it through a wrapper instead.
		t.Logf("carrier on %s (port overridden in test)", carrier)
	}
	f := false
	cfg := config{
		Encrypt: encryptConfig{Enabled: true, Provider: "quad9", Protocol: "dot", Fallback: &f},
	}
	e := newTestEngine(t, cfg, resolv)

	// Encryption on, upstream unreachable, no fallback: SERVFAIL.
	ca := newTestCA(t, "dns.test")
	e.enc.Store(&resolverBox{kind: "dot", r: &dotResolver{host: "dns.test", addrs: []string{"127.0.0.1:1"}, conf: &tls.Config{ServerName: "dns.test", RootCAs: ca.pool}}})
	resp := e.handle(buildQuery(6, "ok.example.org", typeA, 0), 4096)
	if resp[3]&0x0F != 2 {
		t.Fatalf("want SERVFAIL, got rcode %d", resp[3]&0x0F)
	}

	// Same outage with fallback on: answered by the carrier resolver, counted as fallback.
	e.plain.port = port
	e.plain.allowLocal = true
	tr := true
	cfg2 := cfg
	cfg2.Encrypt.Fallback = &tr
	e.cfg.Store(&cfg2)
	resp = e.handle(buildQuery(8, "ok.example.org", typeA, 0), 4096)
	if resp[3]&0x0F != 0 || e.fallbackN.Load() != 1 || binary.BigEndian.Uint16(resp[6:8]) != 1 {
		t.Fatalf("fallback failed rcode=%d fb=%d", resp[3]&0x0F, e.fallbackN.Load())
	}
	// Encryption off: plain only, big answers truncated for a 512-byte UDP client.
	cfg3 := cfg
	cfg3.Encrypt.Enabled = false
	e.cfg.Store(&cfg3)
	resp = e.handle(buildQuery(9, "ok.example.org", typeA, 0), 4096)
	if resp[3]&0x0F != 0 {
		t.Fatal("plain forward failed")
	}
	e.cfg.Store(&cfg)

	// Working DoT upstream.
	addr, n := dotServer(t, ca)
	e.enc.Store(&resolverBox{kind: "dot", r: &dotResolver{host: "dns.test", addrs: []string{addr}, conf: &tls.Config{ServerName: "dns.test", RootCAs: ca.pool}}})
	resp = e.handle(buildQuery(7, "ok.example.org", typeA, 0), 4096)
	if resp[3]&0x0F != 0 || *n != 1 || e.encrypted.Load() != 1 {
		t.Fatalf("encrypted forward failed rcode=%d n=%d", resp[3]&0x0F, *n)
	}

	e.writeStatus()
	b, _ := os.ReadFile(e.statPath)
	if !strings.Contains(string(b), `"encrypted":1`) || strings.Contains(string(b), "blocked") {
		t.Fatalf("status: %s", b)
	}
}

func TestPlainResolverSkipsLoopback(t *testing.T) {
	p := filepath.Join(t.TempDir(), "r")
	os.WriteFile(p, []byte("# x\nnameserver 127.0.0.1\nnameserver ::1\nnameserver 10.151.151.44\nsearch lan\n"), 0o644)
	r := &plainResolver{files: []string{filepath.Join(t.TempDir(), "missing"), p}}
	got := r.servers()
	if len(got) != 1 || got[0] != "10.151.151.44" {
		t.Fatalf("servers %v", got)
	}
}

func TestProviders(t *testing.T) {
	for _, id := range []string{"quad9", "cloudflare", "google", "adguard", "mullvad"} {
		p, err := providerFor(encryptConfig{Provider: id})
		if err != nil || p.DoTHost == "" || len(p.IPs) == 0 {
			t.Errorf("%s: %+v %v", id, p, err)
		}
	}
	if _, err := providerFor(encryptConfig{Provider: "nextdns", NextDNSID: "AB"}); err == nil {
		t.Error("bad nextdns id accepted")
	}
	if p, err := providerFor(encryptConfig{Provider: "nextdns", NextDNSID: "abc123"}); err != nil || p.DoTHost != "abc123.dns.nextdns.io" {
		t.Errorf("nextdns: %+v %v", p, err)
	}
	if _, err := providerFor(encryptConfig{Provider: "custom", CustomHost: "dns.x", CustomIP: "nope"}); err == nil {
		t.Error("custom without IP accepted")
	}
}

func TestTruncationThroughEngine(t *testing.T) {
	carrier := plainServer(t, 60) // ~1 KB answer
	host, port, _ := net.SplitHostPort(carrier)
	resolv := filepath.Join(t.TempDir(), "resolv.conf")
	os.WriteFile(resolv, []byte("nameserver "+host+"\n"), 0o644)
	e := newTestEngine(t, config{}, resolv)
	e.plain.port = port
	e.plain.allowLocal = true
	small := e.handle(buildQuery(1, "big.example", typeA, 0), 4096)
	if small[2]&0x02 == 0 || len(small) > 512 {
		t.Fatalf("512-byte client not truncated (%d bytes)", len(small))
	}
	full := e.handle(buildQuery(2, "big.example", typeA, 1232), 4096)
	if full[2]&0x02 != 0 || binary.BigEndian.Uint16(full[6:8]) != 60 {
		t.Fatal("EDNS client got a truncated answer")
	}
	tcp := e.handle(buildQuery(3, "big.example", typeA, 0), 0)
	if tcp[2]&0x02 != 0 {
		t.Fatal("TCP answer truncated")
	}
}

func TestIsLocalName(t *testing.T) {
	yes := []string{"router", "nas.lan", "printer.home.arpa", "5.225.168.192.in-addr.arpa", "1.0.0.10.in-addr.arpa",
		"9.1.20.172.in-addr.arpa", "1.1.254.169.in-addr.arpa", "box.localdomain"}
	no := []string{"", "google.com", "lan.example.com", "8.8.8.8.in-addr.arpa", "1.1.32.172.in-addr.arpa", "1.1.15.172.in-addr.arpa"}
	for _, n := range yes {
		if !isLocalName(n) {
			t.Errorf("%s should be local", n)
		}
	}
	for _, n := range no {
		if isLocalName(n) {
			t.Errorf("%s should not be local", n)
		}
	}
}

func TestDoTStalePool(t *testing.T) {
	ca := newTestCA(t, "dns.test")
	addr, _ := dotServerOpts(t, ca, true)
	r := &dotResolver{host: "dns.test", addrs: []string{addr}, conf: &tls.Config{ServerName: "dns.test", RootCAs: ca.pool}}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r.exchange(context.Background(), buildQuery(uint16(i+1), "a.example", 1, 0))
		}(i)
	}
	wg.Wait()
	time.Sleep(100 * time.Millisecond)
	if _, err := r.exchange(context.Background(), buildQuery(9, "b.example", 1, 0)); err != nil {
		t.Fatalf("stale pooled connections should be dropped and redialled: %v", err)
	}
}
