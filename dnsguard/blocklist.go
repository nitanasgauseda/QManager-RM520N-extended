package main

import (
	"bufio"
	"io"
	"os"
	"sort"
	"strings"
)

// A domain set is one string of sorted names plus offsets: about the raw list size
// in memory, where a Go map would cost 4-5x on a 178 MB modem.
type domainSet struct {
	blob string
	offs []uint32
}

func newDomainSet(domains []string) *domainSet {
	sort.Strings(domains)
	total := 0
	for _, d := range domains {
		total += len(d) + 1
	}
	var sb strings.Builder
	sb.Grow(total) // one allocation instead of doubling
	offs := make([]uint32, 0, len(domains))
	prev := ""
	for _, d := range domains {
		if d == prev {
			continue
		}
		prev = d
		offs = append(offs, uint32(sb.Len()))
		sb.WriteString(d)
		sb.WriteByte('\n')
	}
	return &domainSet{blob: sb.String(), offs: offs}
}

func (s *domainSet) len() int {
	if s == nil {
		return 0
	}
	return len(s.offs)
}

func (s *domainSet) at(i int) string {
	start := int(s.offs[i])
	end := strings.IndexByte(s.blob[start:], '\n')
	return s.blob[start : start+end]
}

func (s *domainSet) has(d string) bool {
	if s.len() == 0 {
		return false
	}
	i := sort.Search(len(s.offs), func(i int) bool { return s.at(i) >= d })
	return i < len(s.offs) && s.at(i) == d
}

// match reports the listed name covering name: the name itself or any parent with a dot in it.
func (s *domainSet) match(name string) (string, bool) {
	if s.len() == 0 || name == "" {
		return "", false
	}
	for {
		if s.has(name) {
			return name, true
		}
		i := strings.IndexByte(name, '.')
		if i < 0 {
			return "", false
		}
		name = name[i+1:]
		if strings.IndexByte(name, '.') < 0 {
			return "", false // never block a whole TLD
		}
	}
}

func validDomain(d string) bool {
	if len(d) < 3 || len(d) > 253 || strings.IndexByte(d, '.') < 0 {
		return false
	}
	if d[0] == '.' || d[0] == '-' || d[len(d)-1] == '.' || strings.Contains(d, "..") {
		return false
	}
	digitsAndDots := true
	for i := 0; i < len(d); i++ {
		c := d[i]
		switch {
		case c >= 'a' && c <= 'z', c == '-', c == '_':
			digitsAndDots = false
		case c >= '0' && c <= '9', c == '.':
		default:
			return false
		}
	}
	return !digitsAndDots // an IPv4 address is not a domain
}

// normalizeDomain lower-cases and trims a user entry; "" if it is not a domain.
func normalizeDomain(s string) string {
	d := strings.ToLower(strings.TrimSpace(s))
	d = strings.TrimPrefix(d, "*.")
	d = strings.TrimSuffix(d, ".")
	if !validDomain(d) {
		return ""
	}
	return d
}

// parseListLine accepts plain domains, hosts files, AdBlock "||x^" and dnsmasq
// "local=/x/" / "address=/x/..." / "server=/x/" lines.
func parseListLine(line string) string {
	line = strings.TrimSpace(line)
	if line == "" || line[0] == '#' || line[0] == '!' || line[0] == '[' {
		return ""
	}
	if i := strings.IndexByte(line, '#'); i >= 0 {
		line = strings.TrimSpace(line[:i])
	}
	switch {
	case strings.HasPrefix(line, "||"):
		line = strings.TrimPrefix(line, "||")
		if i := strings.IndexAny(line, "^$/"); i >= 0 {
			if line[i] != '^' || i != len(line)-1 {
				return "" // rules with options or paths are not plain domain blocks
			}
			line = line[:i]
		}
	case strings.HasPrefix(line, "local=/"), strings.HasPrefix(line, "address=/"), strings.HasPrefix(line, "server=/"):
		parts := strings.Split(line, "/")
		if len(parts) < 3 {
			return ""
		}
		line = parts[1]
	default:
		fields := strings.Fields(line)
		switch len(fields) {
		case 1:
			line = fields[0]
		case 2:
			if fields[0] != "0.0.0.0" && fields[0] != "127.0.0.1" && fields[0] != "::" && fields[0] != "::1" {
				return ""
			}
			line = fields[1]
		default:
			return ""
		}
	}
	d := normalizeDomain(line)
	switch d {
	case "localhost.localdomain", "local", "broadcasthost", "ip6-localhost", "ip6-loopback":
		return ""
	}
	return d
}

// readList parses a list file, appending at most max names.
func readList(r io.Reader, out []string, max int) ([]string, int) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	n := 0
	for sc.Scan() {
		if d := parseListLine(sc.Text()); d != "" {
			if len(out) >= max {
				break
			}
			out = append(out, d)
			n++
		}
	}
	return out, n
}

func readListFile(path string, out []string, max int) ([]string, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return out, 0, err
	}
	defer f.Close()
	out, n := readList(f, out, max)
	return out, n, nil
}

type listSpec struct {
	URL string
}

// Built-in catalogue; the page offers exactly these ids.
var catalog = map[string]listSpec{
	"hagezi_light":    {"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/light-onlydomains.txt"},
	"hagezi_normal":   {"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/multi-onlydomains.txt"},
	"hagezi_pro":      {"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/pro-onlydomains.txt"},
	"hagezi_tif_mini": {"https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/tif.mini-onlydomains.txt"},
	"stevenblack":     {"https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"},
}

// maxDomains caps the merged block set (about 7 MB with offsets).
const maxDomains = 300000
