package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestWSDialAndFrame(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	done := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			done <- err
			return
		}
		defer c.Close()
		br := bufio.NewReader(c)
		req, err := httpReadUntilBlank(br)
		if err != nil {
			done <- err
			return
		}
		lines := strings.Split(req, "\r\n")
		var key string
		for _, line := range lines {
			if strings.HasPrefix(strings.ToLower(line), "sec-websocket-key:") {
				key = strings.TrimSpace(strings.SplitN(line, ":", 2)[1])
			}
		}
		if key == "" {
			done <- fmt.Errorf("missing key")
			return
		}
		_, err = io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+websocketAccept(key)+"\r\n\r\n")
		if err != nil {
			done <- err
			return
		}
		// Send unmasked text frame with X-Plane-like JSON.
		payload := []byte(`{"req_id":1,"type":"result","success":true}`)
		frame := append([]byte{0x81, byte(len(payload))}, payload...)
		_, err = c.Write(frame)
		done <- err
	}()
	w, err := wsDial(ln.Addr().String(), "/api/v3")
	if err != nil {
		t.Fatal(err)
	}
	defer w.close()
	op, p, err := w.readFrame()
	if err != nil {
		t.Fatal(err)
	}
	if op != 1 || !strings.Contains(string(p), `"success":true`) {
		t.Fatalf("bad frame op=%d payload=%s", op, p)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server timeout")
	}
}

func httpReadUntilBlank(br *bufio.Reader) (string, error) {
	var b strings.Builder
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return "", err
		}
		b.WriteString(line)
		if strings.TrimSpace(line) == "" {
			return b.String(), nil
		}
	}
}
