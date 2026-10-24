// qmanager_esim — runs lpac (stdio drivers) for QManager: APDUs go to the SIM through qcmd
// (AT+CCHO/CGLA, AT+CSIM fallback), HTTPS to the SM-DP+ is done here. See docs/reference/esim.md.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	lpacPath  = envOr("ESIM_LPAC", "/usrdata/qmanager/bin/qmanager_lpac")
	qcmdPath  = envOr("ESIM_QCMD", "/usr/bin/qcmd")
	chanFile  = envOr("ESIM_CHANNELS", "/tmp/qmanager_esim_channels")
	statusOut string
	verbose   = os.Getenv("ESIM_DEBUG") == "1"
)

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

type result struct {
	Success bool            `json:"success"`
	Error   string          `json:"error,omitempty"`
	Detail  string          `json:"detail,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func emit(r result) {
	b, _ := json.Marshal(r)
	fmt.Println(string(b))
	if statusOut != "" {
		writeStatus(map[string]any{"running": false, "finished": time.Now().Unix(), "result": r})
	}
	if r.Success {
		os.Exit(0)
	}
	os.Exit(1)
}

func fail(code, detail string) { emit(result{Error: code, Detail: detail}) }

var startedAt = time.Now().Unix()

func writeStatus(v map[string]any) {
	v["started"] = startedAt
	if _, ok := v["updated"]; !ok {
		v["updated"] = time.Now().Unix()
	}
	b, _ := json.Marshal(v)
	tmp := statusOut + ".tmp"
	if os.WriteFile(tmp, append(b, '\n'), 0644) == nil {
		os.Rename(tmp, statusOut)
	}
}

var (
	reICCID = regexp.MustCompile(`^[0-9]{18,20}[Ff]?$`)
	reAID   = regexp.MustCompile(`^[0-9A-Fa-f]{10,32}$`)
)

func validName(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func main() {
	flag.StringVar(&statusOut, "status", "", "write progress and the result to this file")
	flag.Parse()
	args := flag.Args()
	if len(args) < 1 {
		fail("invalid_action", "usage: qmanager_esim [-status file] info|list|enable|disable|delete|nickname|download|notify")
	}
	var lpacArgs []string
	timeout := 90 * time.Second
	stdinLine := func() string {
		r := bufio.NewReader(io.LimitReader(os.Stdin, 4096))
		s, _ := r.ReadString('\n')
		return strings.TrimRight(s, "\r\n")
	}
	needICCID := func() string {
		if len(args) != 2 || !reICCID.MatchString(args[1]) {
			fail("invalid_iccid", "a profile ICCID is required")
		}
		return args[1]
	}
	switch args[0] {
	case "info":
		lpacArgs = []string{"chip", "info"}
	case "list":
		lpacArgs = []string{"profile", "list"}
	case "enable":
		lpacArgs = []string{"profile", "enable", needICCID(), "1"}
	case "disable":
		lpacArgs = []string{"profile", "disable", needICCID(), "1"}
	case "delete":
		lpacArgs = []string{"profile", "delete", needICCID()}
	case "nickname":
		id := needICCID()
		name := stdinLine()
		if !validName(name) {
			fail("invalid_name", "1-64 printable characters")
		}
		lpacArgs = []string{"profile", "nickname", id, name}
	case "notify":
		lpacArgs = []string{"notification", "process", "-a", "-r"}
		timeout = 180 * time.Second
	case "download":
		// {"code":"LPA:1$...","confirm":"..."} on stdin: activation codes never reach argv.
		var in struct {
			Code    string `json:"code"`
			Confirm string `json:"confirm"`
		}
		if json.Unmarshal([]byte(stdinLine()), &in) != nil {
			fail("invalid_request", "expected a JSON line on stdin")
		}
		in.Code = strings.TrimSpace(in.Code)
		if !strings.HasPrefix(strings.ToUpper(in.Code), "LPA:1$") || len(in.Code) > 512 || !validName(in.Code[:min(len(in.Code), 64)]) {
			fail("invalid_code", "the activation code must start with LPA:1$")
		}
		lpacArgs = []string{"profile", "download", "-a", in.Code}
		if c := strings.TrimSpace(in.Confirm); c != "" {
			if len(c) > 64 || !validName(c) {
				fail("invalid_code", "invalid confirmation code")
			}
			lpacArgs = append(lpacArgs, "-c", c)
		}
		timeout = 300 * time.Second
	default:
		fail("invalid_action", "unknown verb")
	}
	if statusOut != "" {
		writeStatus(map[string]any{"running": true, "started": time.Now().Unix(), "step": "starting"})
	}
	emit(run(lpacArgs, timeout))
}

// --- lpac driver loop -------------------------------------------------------------

type msg struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

func run(lpacArgs []string, timeout time.Duration) result {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, lpacPath, lpacArgs...)
	cmd.Env = append(os.Environ(), "LPAC_APDU=stdio", "LPAC_HTTP=stdio")
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return result{Error: "lpac_missing", Detail: err.Error()}
	}
	card := &sim{}
	defer card.closeAll()
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var final *result
	for sc.Scan() {
		line := sc.Bytes()
		if verbose {
			fmt.Fprintf(os.Stderr, "lpac> %.300s\n", line)
		}
		var m msg
		if json.Unmarshal(line, &m) != nil {
			continue
		}
		var reply any
		switch m.Type {
		case "apdu":
			reply = card.handle(m.Payload)
		case "http":
			reply = doHTTP(ctx, m.Payload)
		case "progress":
			var p struct {
				Message string `json:"message"`
			}
			json.Unmarshal(m.Payload, &p)
			if statusOut != "" {
				writeStatus(map[string]any{"running": true, "step": p.Message, "updated": time.Now().Unix()})
			}
			continue
		case "lpa":
			var p struct {
				Code    int             `json:"code"`
				Message string          `json:"message"`
				Data    json.RawMessage `json:"data"`
			}
			json.Unmarshal(m.Payload, &p)
			if p.Code == 0 {
				final = &result{Success: true, Data: p.Data}
			} else {
				d := strings.Trim(string(p.Data), `"`)
				final = &result{Error: classify(p.Message, d, card), Detail: strings.TrimSpace(p.Message + " " + d)}
			}
			continue
		default:
			continue
		}
		b, _ := json.Marshal(map[string]any{"type": m.Type, "payload": reply})
		if verbose {
			fmt.Fprintf(os.Stderr, "lpac< %.300s\n", b)
		}
		if _, err := stdin.Write(append(b, '\n')); err != nil {
			break
		}
	}
	stdin.Close()
	cmd.Wait()
	if ctx.Err() != nil {
		return result{Error: "timeout", Detail: "the eSIM did not finish in time"}
	}
	if final != nil {
		return *final
	}
	return result{Error: classify("", stderr.String(), card), Detail: strings.TrimSpace(stderr.String())}
}

func classify(message, detail string, c *sim) string {
	switch {
	case c.noEUICC:
		return "no_euicc"
	case c.busy:
		return "modem_busy"
	case strings.Contains(message, "es9p") || strings.Contains(message, "http") || strings.Contains(detail, "http"):
		return "server_failed"
	}
	return "lpac_failed"
}

// --- APDU over AT -----------------------------------------------------------------

type sim struct {
	mode     string // "etsi" (CCHO/CGLA) or "csim"
	channels []int
	noEUICC  bool
	busy     bool
}

type apduReq struct {
	Func  string `json:"func"`
	Param string `json:"param"`
}

func (s *sim) at(cmd string) (string, error) {
	out, err := exec.Command(qcmdPath, cmd).Output()
	if verbose {
		fmt.Fprintf(os.Stderr, "AT %s -> %q %v\n", cmd, out, err)
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && bytes.Contains(ee.Stderr, []byte("modem_busy")) {
			s.busy = true
		}
		return "", err
	}
	return string(out), nil
}

// field returns the reply line for prefix (e.g. "+CGLA:"), or the first bare value line.
func field(out, prefix string) string {
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(l, prefix))
		}
	}
	return ""
}

// hexReply parses `len,"HEX"` into bytes.
func hexReply(v string) ([]byte, bool) {
	i := strings.IndexByte(v, ',')
	if i < 0 {
		return nil, false
	}
	b, err := hex.DecodeString(strings.Trim(strings.TrimSpace(v[i+1:]), `"`))
	return b, err == nil && len(b) >= 2
}

func (s *sim) csim(apdu []byte) ([]byte, bool) {
	h := strings.ToUpper(hex.EncodeToString(apdu))
	out, err := s.at(fmt.Sprintf(`AT+CSIM=%d,"%s"`, len(h), h))
	if err != nil {
		return nil, false
	}
	return hexReply(field(out, "+CSIM:"))
}

func (s *sim) handle(raw json.RawMessage) map[string]any {
	var r apduReq
	json.Unmarshal(raw, &r)
	switch r.Func {
	case "connect":
		s.closeStale()
		return map[string]any{"ecode": 0}
	case "disconnect":
		s.closeAll()
		return map[string]any{"ecode": 0}
	case "logic_channel_open":
		if !reAID.MatchString(r.Param) {
			return map[string]any{"ecode": -1}
		}
		ch := s.open(strings.ToUpper(r.Param))
		if ch > 0 {
			s.channels = append(s.channels, ch)
			s.saveChannels()
		}
		return map[string]any{"ecode": ch}
	case "logic_channel_close":
		if b, err := hex.DecodeString(r.Param); err == nil && len(b) == 1 {
			s.close(int(b[0]))
		}
		return map[string]any{"ecode": 0}
	case "transmit":
		tx, err := hex.DecodeString(r.Param)
		if err != nil || len(tx) < 4 || len(s.channels) == 0 {
			return map[string]any{"ecode": -1}
		}
		var rx []byte
		ok := false
		if s.mode == "etsi" {
			h := strings.ToUpper(r.Param)
			out, err := s.at(fmt.Sprintf(`AT+CGLA=%d,%d,"%s"`, s.channels[len(s.channels)-1], len(h), h))
			if err == nil {
				rx, ok = hexReply(field(out, "+CGLA:"))
			}
		} else {
			rx, ok = s.csim(tx)
		}
		if !ok {
			return map[string]any{"ecode": -1}
		}
		return map[string]any{"ecode": 0, "data": strings.ToUpper(hex.EncodeToString(rx))}
	}
	return map[string]any{"ecode": -1}
}

func (s *sim) open(aid string) int {
	if s.mode != "csim" {
		out, err := s.at(fmt.Sprintf(`AT+CCHO="%s"`, aid))
		if err == nil {
			v := field(out, "+CCHO:")
			if v == "" {
				for _, l := range strings.Split(out, "\n") {
					if n, e := strconv.Atoi(strings.TrimSpace(l)); e == nil {
						v = strconv.Itoa(n)
						break
					}
				}
			}
			if n, e := strconv.Atoi(v); e == nil && n > 0 {
				s.mode = "etsi"
				return n
			}
		}
		if s.busy {
			return -1
		}
	}
	// AT+CSIM fallback: MANAGE CHANNEL, then SELECT on that channel.
	rx, ok := s.csim([]byte{0x00, 0x70, 0x00, 0x00, 0x01})
	if !ok || len(rx) != 3 || rx[1] != 0x90 {
		s.noEUICC = !s.busy
		return -1
	}
	ch := int(rx[0])
	aidb, _ := hex.DecodeString(aid)
	cla := byte(ch)
	if ch > 3 {
		cla = 0x40 | byte(ch-4)
	}
	sel := append([]byte{cla, 0xA4, 0x04, 0x00, byte(len(aidb))}, aidb...)
	rx, ok = s.csim(sel)
	if !ok || (rx[len(rx)-2] != 0x90 && rx[len(rx)-2] != 0x61) {
		s.csim([]byte{0x00, 0x70, 0x80, byte(ch), 0x00})
		s.noEUICC = !s.busy
		return -1
	}
	s.mode = "csim"
	return ch
}

func (s *sim) close(ch int) {
	if s.mode == "csim" {
		s.csim([]byte{0x00, 0x70, 0x80, byte(ch), 0x00})
	} else {
		s.at(fmt.Sprintf("AT+CCHC=%d", ch))
	}
	for i, c := range s.channels {
		if c == ch {
			s.channels = append(s.channels[:i], s.channels[i+1:]...)
			break
		}
	}
	s.saveChannels()
}

func (s *sim) closeAll() {
	for len(s.channels) > 0 {
		s.close(s.channels[len(s.channels)-1])
	}
}

// A crashed run leaves its channel open; the SIM has only a few, so close what the last run recorded.
func (s *sim) closeStale() {
	b, err := os.ReadFile(chanFile)
	if err != nil {
		return
	}
	for _, f := range strings.Fields(string(b)) {
		p := strings.SplitN(f, ":", 2)
		if len(p) != 2 {
			continue
		}
		n, e := strconv.Atoi(p[1])
		if e != nil || n < 1 || n > 19 {
			continue
		}
		if p[0] == "csim" {
			s.csim([]byte{0x00, 0x70, 0x80, byte(n), 0x00})
		} else {
			s.at(fmt.Sprintf("AT+CCHC=%d", n))
		}
	}
	os.Remove(chanFile)
}

func (s *sim) saveChannels() {
	if len(s.channels) == 0 {
		os.Remove(chanFile)
		return
	}
	var b strings.Builder
	for _, c := range s.channels {
		fmt.Fprintf(&b, "%s:%d\n", map[bool]string{true: "csim", false: "etsi"}[s.mode == "csim"], c)
	}
	os.WriteFile(chanFile, []byte(b.String()), 0644)
}

// --- HTTPS to the SM-DP+ ----------------------------------------------------------

// SM-DP+ servers present GSMA CI certificates that public roots do not cover; the eUICC
// authenticates the server itself (ES9+ authenticateServer), as lpac's own curl driver relies on.
var client = &http.Client{
	Timeout: 60 * time.Second,
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12},
		Proxy:           nil,
	},
}

func doHTTP(ctx context.Context, raw json.RawMessage) map[string]any {
	var r struct {
		URL     string   `json:"url"`
		TX      string   `json:"tx"`
		Headers []string `json:"headers"`
	}
	json.Unmarshal(raw, &r)
	fail := map[string]any{"rcode": 0, "rx": ""}
	if !strings.HasPrefix(r.URL, "https://") {
		return fail
	}
	body, err := hex.DecodeString(r.TX)
	if err != nil {
		return fail
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.URL, bytes.NewReader(body))
	if err != nil {
		return fail
	}
	for _, h := range r.Headers {
		if k, v, ok := strings.Cut(h, ":"); ok {
			req.Header.Set(strings.TrimSpace(k), strings.TrimSpace(v))
		}
	}
	if statusOut != "" {
		writeStatus(map[string]any{"running": true, "step": "server", "updated": time.Now().Unix()})
	}
	resp, err := client.Do(req)
	if err != nil {
		if verbose {
			fmt.Fprintf(os.Stderr, "http: %v\n", err)
		}
		return fail
	}
	defer resp.Body.Close()
	rx, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	return map[string]any{"rcode": resp.StatusCode, "rx": strings.ToUpper(hex.EncodeToString(rx))}
}
