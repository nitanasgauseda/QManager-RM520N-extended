package main

import (
	"encoding/binary"
	"errors"
	"strings"
)

// Minimal DNS wire handling: just enough to read the question, answer a blocked
// name, and size a UDP reply. Everything else is forwarded byte for byte.

const (
	typeA    = 1
	typeAAAA = 28
	typeOPT  = 41
	blockTTL = 300
)

var errMalformed = errors.New("malformed dns message")

type query struct {
	id      uint16
	name    string // lower case, no trailing dot; "" for the root
	qtype   uint16
	qend    int // end offset of the question section
	udpSize int // EDNS0 payload size the client accepts over UDP (512 without EDNS)
	single  bool
}

// readName reads an uncompressed name at off; queries never use compression.
func readName(b []byte, off int) (string, int, error) {
	var sb strings.Builder
	for {
		if off >= len(b) {
			return "", 0, errMalformed
		}
		l := int(b[off])
		off++
		if l == 0 {
			break
		}
		if l&0xC0 != 0 || off+l > len(b) || sb.Len()+l > 253 {
			return "", 0, errMalformed
		}
		if sb.Len() > 0 {
			sb.WriteByte('.')
		}
		for _, c := range b[off : off+l] {
			if c >= 'A' && c <= 'Z' {
				c += 'a' - 'A'
			}
			sb.WriteByte(c)
		}
		off += l
	}
	return sb.String(), off, nil
}

// skipName skips a possibly compressed name in an RR.
func skipName(b []byte, off int) (int, error) {
	for {
		if off >= len(b) {
			return 0, errMalformed
		}
		l := int(b[off])
		switch {
		case l == 0:
			return off + 1, nil
		case l&0xC0 == 0xC0:
			return off + 2, nil
		case l&0xC0 != 0:
			return 0, errMalformed
		}
		off += 1 + l
	}
}

func parseQuery(b []byte) (query, error) {
	q := query{udpSize: 512}
	if len(b) < 12 {
		return q, errMalformed
	}
	q.id = binary.BigEndian.Uint16(b[0:2])
	if b[2]&0x80 != 0 { // a response, not a query
		return q, errMalformed
	}
	qd := binary.BigEndian.Uint16(b[4:6])
	an := binary.BigEndian.Uint16(b[6:8])
	ns := binary.BigEndian.Uint16(b[8:10])
	ar := binary.BigEndian.Uint16(b[10:12])
	if qd != 1 {
		return q, nil // forwarded untouched
	}
	name, off, err := readName(b, 12)
	if err != nil || off+4 > len(b) {
		return q, errMalformed
	}
	q.name = name
	q.qtype = binary.BigEndian.Uint16(b[off : off+2])
	q.qend = off + 4
	q.single = true
	off = q.qend
	for i := 0; i < int(an)+int(ns)+int(ar); i++ {
		if off, err = skipName(b, off); err != nil || off+10 > len(b) {
			return q, nil
		}
		t := binary.BigEndian.Uint16(b[off : off+2])
		class := binary.BigEndian.Uint16(b[off+2 : off+4])
		rdlen := int(binary.BigEndian.Uint16(b[off+8 : off+10]))
		if t == typeOPT && class >= 512 {
			q.udpSize = int(class)
		}
		off += 10 + rdlen
	}
	return q, nil
}

// header builds a response header for query b.
func header(b []byte, rcode byte, an uint16) []byte {
	h := make([]byte, 12)
	copy(h[0:2], b[0:2])
	h[2] = 0x80 | (b[2] & 0x79)  // QR, keep opcode and RD
	h[3] = 0x80 | (rcode & 0x0F) // RA
	binary.BigEndian.PutUint16(h[4:6], 1)
	binary.BigEndian.PutUint16(h[6:8], an)
	return h
}

// failReply is SERVFAIL with the question echoed when it could be parsed.
func failReply(b []byte, q query) []byte {
	if len(b) < 12 {
		return nil
	}
	if !q.single {
		h := header(b, 2, 0)
		binary.BigEndian.PutUint16(h[4:6], 0)
		return h
	}
	return append(header(b, 2, 0), b[12:q.qend]...)
}

// fitUDP returns resp unchanged when it fits, else a truncated reply (TC set) so the client retries over TCP.
func fitUDP(resp []byte, q query, max int) []byte {
	if len(resp) <= max || len(resp) < 12 {
		return resp
	}
	h := make([]byte, 12)
	copy(h, resp[:12])
	h[2] |= 0x02
	for i := 6; i < 12; i++ {
		h[i] = 0
	}
	if q.single && q.qend <= len(resp) {
		return append(h, resp[12:q.qend]...)
	}
	binary.BigEndian.PutUint16(h[4:6], 0)
	return h
}
