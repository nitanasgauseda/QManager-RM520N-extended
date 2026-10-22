package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type resolver interface {
	exchange(ctx context.Context, msg []byte) ([]byte, error)
}

var errIDMismatch = errors.New("upstream answered a different query")

// provider describes an encrypted resolver; IPs avoid needing DNS to find DNS.
type provider struct {
	DoTHost string
	IPs     []string
}

func providerFor(c encryptConfig) (provider, error) {
	switch c.Provider {
	case "quad9":
		return provider{"dns.quad9.net", []string{"9.9.9.9", "149.112.112.112"}}, nil
	case "cloudflare":
		return provider{"one.one.one.one", []string{"1.1.1.1", "1.0.0.1"}}, nil
	case "google":
		return provider{"dns.google", []string{"8.8.8.8", "8.8.4.4"}}, nil
	case "adguard":
		return provider{"dns.adguard-dns.com", []string{"94.140.14.14", "94.140.15.15"}}, nil
	case "mullvad":
		return provider{"dns.mullvad.net", []string{"194.242.2.2"}}, nil
	case "nextdns":
		if !validNextDNSID(c.NextDNSID) {
			return provider{}, errors.New("nextdns id missing")
		}
		return provider{c.NextDNSID + ".dns.nextdns.io", []string{"45.90.28.0", "45.90.30.0"}}, nil
	case "custom":
		ip := net.ParseIP(c.CustomIP)
		if ip == nil || c.CustomHost == "" {
			return provider{}, errors.New("custom resolver needs a host name and an IP address")
		}
		return provider{c.CustomHost, []string{ip.String()}}, nil
	}
	return provider{}, fmt.Errorf("unknown provider %q", c.Provider)
}

func validNextDNSID(s string) bool {
	if len(s) < 4 || len(s) > 16 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

func hostPort(ip, port string) string { return net.JoinHostPort(ip, port) }

// --- DNS over TLS (RFC 7858): length-prefixed messages over a pooled TLS connection.

type dotResolver struct {
	host  string
	addrs []string
	conf  *tls.Config
	next  uint32
	mu    sync.Mutex
	idle  []*tls.Conn
}

func newDoT(p provider, roots *x509.CertPool) *dotResolver {
	addrs := make([]string, len(p.IPs))
	for i, ip := range p.IPs {
		addrs[i] = hostPort(ip, "853")
	}
	return &dotResolver{host: p.DoTHost, addrs: addrs, conf: &tls.Config{ServerName: p.DoTHost, RootCAs: roots, MinVersion: tls.VersionTLS12}}
}

func (r *dotResolver) dial(ctx context.Context) (*tls.Conn, error) {
	i := atomic.AddUint32(&r.next, 1)
	addr := r.addrs[int(i)%len(r.addrs)]
	d := &tls.Dialer{NetDialer: &net.Dialer{Timeout: 4 * time.Second}, Config: r.conf}
	c, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	return c.(*tls.Conn), nil
}

func (r *dotResolver) get(ctx context.Context) (*tls.Conn, bool, error) {
	r.mu.Lock()
	if n := len(r.idle); n > 0 {
		c := r.idle[n-1]
		r.idle = r.idle[:n-1]
		r.mu.Unlock()
		return c, true, nil
	}
	r.mu.Unlock()
	c, err := r.dial(ctx)
	return c, false, err
}

func (r *dotResolver) put(c *tls.Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.idle) >= 4 {
		c.Close()
		return
	}
	r.idle = append(r.idle, c)
}

func (r *dotResolver) close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, c := range r.idle {
		c.Close()
	}
	r.idle = nil
}

func streamExchange(c net.Conn, msg []byte, deadline time.Time) ([]byte, error) {
	c.SetDeadline(deadline)
	buf := make([]byte, 2+len(msg))
	binary.BigEndian.PutUint16(buf, uint16(len(msg)))
	copy(buf[2:], msg)
	if _, err := c.Write(buf); err != nil {
		return nil, err
	}
	var lb [2]byte
	if _, err := io.ReadFull(c, lb[:]); err != nil {
		return nil, err
	}
	resp := make([]byte, binary.BigEndian.Uint16(lb[:]))
	if _, err := io.ReadFull(c, resp); err != nil {
		return nil, err
	}
	if len(resp) < 12 || !bytes.Equal(resp[0:2], msg[0:2]) {
		return nil, errIDMismatch
	}
	return resp, nil
}

func (r *dotResolver) exchange(ctx context.Context, msg []byte) ([]byte, error) {
	var lastErr error
	// Up to three tries: a pooled connection may have gone stale, and a fresh dial rotates address.
	for attempt := 0; attempt < 3 && ctx.Err() == nil; attempt++ {
		c, _, err := r.get(ctx)
		if err != nil {
			lastErr = err
			continue
		}
		deadline := time.Now().Add(4 * time.Second)
		if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
			deadline = d
		}
		resp, err := streamExchange(c, msg, deadline)
		if err == nil {
			c.SetDeadline(time.Time{})
			r.put(c)
			return resp, nil
		}
		c.Close()
		lastErr = err
	}
	return nil, lastErr
}

// --- Plain DNS to the carrier's resolvers (used when encryption is off, or as fallback).

type plainResolver struct {
	files []string
	port  string // "53" when empty
	// allowLocal is for tests, where the fake carrier resolver lives on loopback.
	allowLocal bool
	mu         sync.Mutex
	at         time.Time
	cache      []string
}

func localAddrs() map[string]bool {
	m := map[string]bool{}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok {
			m[ipn.IP.String()] = true
		}
	}
	return m
}

// servers reads the carrier resolvers QCMAP writes, skipping anything that would loop back to us.
func (r *plainResolver) servers() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if time.Since(r.at) < 30*time.Second && len(r.cache) > 0 {
		return r.cache
	}
	local := localAddrs()
	var out []string
	for _, f := range r.files {
		fh, err := os.Open(f)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(fh)
		for sc.Scan() {
			fs := strings.Fields(sc.Text())
			if len(fs) < 2 || fs[0] != "nameserver" {
				continue
			}
			ip := net.ParseIP(fs[1])
			if ip == nil || ip.IsUnspecified() || !r.allowLocal && (ip.IsLoopback() || local[ip.String()]) {
				continue
			}
			out = append(out, ip.String())
		}
		fh.Close()
		if len(out) > 0 {
			break
		}
	}
	r.cache, r.at = out, time.Now()
	return out
}

func (r *plainResolver) exchange(ctx context.Context, msg []byte) ([]byte, error) {
	servers := r.servers()
	if len(servers) == 0 {
		return nil, errors.New("no carrier DNS servers known")
	}
	port := r.port
	if port == "" {
		port = "53"
	}
	var lastErr error
	for _, s := range servers {
		addr := hostPort(s, port)
		resp, err := udpExchange(ctx, addr, msg)
		if err == nil && len(resp) >= 12 && resp[2]&0x02 != 0 {
			resp, err = tcpExchange(ctx, addr, msg)
		}
		if err == nil {
			return resp, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func deadlineFor(ctx context.Context, d time.Duration) time.Time {
	t := time.Now().Add(d)
	if cd, ok := ctx.Deadline(); ok && cd.Before(t) {
		return cd
	}
	return t
}

func udpExchange(ctx context.Context, addr string, msg []byte) ([]byte, error) {
	c, err := net.Dial("udp", addr)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	c.SetDeadline(deadlineFor(ctx, 2500*time.Millisecond))
	if _, err := c.Write(msg); err != nil {
		return nil, err
	}
	buf := make([]byte, 65535)
	for {
		n, err := c.Read(buf)
		if err != nil {
			return nil, err
		}
		if n >= 12 && buf[0] == msg[0] && buf[1] == msg[1] {
			return append([]byte(nil), buf[:n]...), nil
		}
	}
}

func tcpExchange(ctx context.Context, addr string, msg []byte) ([]byte, error) {
	c, err := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	return streamExchange(c, msg, deadlineFor(ctx, 4*time.Second))
}

func tlsConfigWith(roots *x509.CertPool) *tls.Config {
	return &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
}
