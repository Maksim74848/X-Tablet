package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"

	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"x-tablet/qrcode"
)

const xpHost = "127.0.0.1:8086"

// wsClient is a small RFC6455 client used only for X-Plane's local API.
type wsClient struct {
	c   net.Conn
	r   *bufio.Reader
	wmu sync.Mutex
}

// appLogger writes a bounded rolling application log. Secrets are never passed to it.
type appLogger struct {
	mu sync.Mutex
	*log.Logger
	file *os.File
	path string
	max  int64
	keep int
}

func newAppLogger() (*appLogger, error) {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		if u, err := os.UserHomeDir(); err == nil {
			base = filepath.Join(u, ".x-tablet")
		} else {
			base = ".x-tablet"
		}
	}
	dir := filepath.Join(base, "X-Tablet", "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "x-tablet.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	l := &appLogger{Logger: log.New(io.MultiWriter(f), "", log.LstdFlags|log.Lmicroseconds), file: f, path: path, max: 5 * 1024 * 1024, keep: 5}
	return l, nil
}

func (l *appLogger) rotateIfNeededLocked() {
	if l.file == nil {
		return
	}
	st, err := l.file.Stat()
	if err != nil || st.Size() < l.max {
		return
	}
	_ = l.file.Close()
	_ = os.Remove(fmt.Sprintf("%s.%d", l.path, l.keep))
	for i := l.keep - 1; i >= 1; i-- {
		old := fmt.Sprintf("%s.%d", l.path, i)
		next := fmt.Sprintf("%s.%d", l.path, i+1)
		if _, err := os.Stat(old); err == nil {
			_ = os.Rename(old, next)
		}
	}
	_ = os.Rename(l.path, l.path+".1")
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err == nil {
		l.file = f
		l.Logger.SetOutput(io.MultiWriter(f))
	}
}

func (l *appLogger) Infof(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateIfNeededLocked()
	l.Printf("INFO  "+format, args...)
}
func (l *appLogger) Errorf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateIfNeededLocked()
	l.Printf("ERROR "+format, args...)
}
func (l *appLogger) Warnf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateIfNeededLocked()
	l.Printf("WARN  "+format, args...)
}
func (l *appLogger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

func wsDial(host, path string) (*wsClient, error) {
	c, err := net.DialTimeout("tcp", host, 4*time.Second)
	if err != nil {
		return nil, err
	}
	keyb := make([]byte, 16)
	if _, err = rand.Read(keyb); err != nil {
		_ = c.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyb)
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", path, host, key)
	if _, err = io.WriteString(c, req); err != nil {
		_ = c.Close()
		return nil, err
	}
	br := bufio.NewReader(c)
	status, err := br.ReadString('\n')
	if err != nil {
		_ = c.Close()
		return nil, err
	}
	if !strings.Contains(status, "101") {
		_ = c.Close()
		return nil, fmt.Errorf("websocket handshake failed: %s", strings.TrimSpace(status))
	}
	headers := map[string]string{}
	for {
		line, e := br.ReadString('\n')
		if e != nil {
			_ = c.Close()
			return nil, e
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		p := strings.SplitN(line, ":", 2)
		if len(p) == 2 {
			headers[strings.ToLower(strings.TrimSpace(p[0]))] = strings.TrimSpace(p[1])
		}
	}
	expected := websocketAccept(key)
	if headers["sec-websocket-accept"] != expected {
		_ = c.Close()
		return nil, fmt.Errorf("bad websocket accept")
	}
	return &wsClient{c: c, r: br}, nil
}

func websocketAccept(key string) string {
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h[:])
}

func (w *wsClient) sendFrame(opcode byte, payload []byte) error {
	w.wmu.Lock()
	defer w.wmu.Unlock()
	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil {
		return err
	}
	n := len(payload)
	hdr := []byte{0x80 | opcode}
	switch {
	case n < 126:
		hdr = append(hdr, byte(n)|0x80)
	case n <= 65535:
		hdr = append(hdr, 126|0x80, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 127|0x80, byte(n>>56), byte(n>>48), byte(n>>40), byte(n>>32), byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	hdr = append(hdr, mask...)
	masked := make([]byte, n)
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	if _, err := w.c.Write(hdr); err != nil {
		return err
	}
	_, err := w.c.Write(masked)
	return err
}

func (w *wsClient) sendText(s string) error { return w.sendFrame(0x1, []byte(s)) }

func (w *wsClient) readFrameEx() (byte, bool, []byte, error) {
	h := make([]byte, 2)
	if _, err := io.ReadFull(w.r, h); err != nil {
		return 0, false, nil, err
	}
	fin := h[0]&0x80 != 0
	opcode := h[0] & 0x0f
	n := int(h[1] & 0x7f)
	if n == 126 {
		b := make([]byte, 2)
		if _, err := io.ReadFull(w.r, b); err != nil {
			return 0, false, nil, err
		}
		n = int(binary.BigEndian.Uint16(b))
	} else if n == 127 {
		b := make([]byte, 8)
		if _, err := io.ReadFull(w.r, b); err != nil {
			return 0, false, nil, err
		}
		nn := binary.BigEndian.Uint64(b)
		if nn > 16*1024*1024 {
			return 0, false, nil, fmt.Errorf("frame too large")
		}
		n = int(nn)
	}
	masked := h[1]&0x80 != 0
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(w.r, mask[:]); err != nil {
			return 0, false, nil, err
		}
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(w.r, p); err != nil {
		return 0, false, nil, err
	}
	if masked {
		for i := range p {
			p[i] ^= mask[i%4]
		}
	}
	return opcode, fin, p, nil
}

func (w *wsClient) readFrame() (byte, []byte, error) {
	op, _, p, err := w.readFrameEx()
	return op, p, err
}

func (w *wsClient) readMessage() (byte, []byte, error) {
	op, fin, payload, err := w.readFrameEx()
	if err != nil {
		return 0, nil, err
	}
	if op == 0x8 || op == 0x9 || op == 0xA {
		return op, payload, nil
	}
	if op != 0x1 && op != 0x2 {
		return 0, nil, fmt.Errorf("unexpected websocket opcode %d", op)
	}
	if fin {
		return op, payload, nil
	}
	var out = append([]byte(nil), payload...)
	for {
		cop, cfin, cp, err := w.readFrameEx()
		if err != nil {
			return 0, nil, err
		}
		if cop == 0x9 {
			_ = w.sendFrame(0xA, cp)
			continue
		}
		if cop != 0x0 {
			return 0, nil, fmt.Errorf("unexpected websocket continuation opcode %d", cop)
		}
		if len(out)+len(cp) > 16*1024*1024 {
			return 0, nil, fmt.Errorf("websocket message too large")
		}
		out = append(out, cp...)
		if cfin {
			return op, out, nil
		}
	}
}

func (w *wsClient) close() {
	if w != nil && w.c != nil {
		_ = w.c.Close()
	}
}

type datarefSpec struct {
	Names []string
	Index *int
}

var datarefSpecs = map[string]datarefSpec{
	"ias":     {Names: []string{"sim/cockpit2/gauges/indicators/airspeed_kts_pilot"}},
	"alt":     {Names: []string{"sim/cockpit2/gauges/indicators/altitude_ft_pilot"}},
	"vs":      {Names: []string{"sim/cockpit2/gauges/indicators/vvi_fpm_pilot"}},
	"hdg":     {Names: []string{"sim/cockpit2/gauges/indicators/heading_elec_deg_mag_pilot"}},
	"pitch":   {Names: []string{"sim/flightmodel/position/theta"}},
	"bank":    {Names: []string{"sim/flightmodel/position/phi"}},
	"gs":      {Names: []string{"sim/flightmodel/position/groundspeed"}},
	"fuel":    {Names: []string{"sim/flightmodel/weight/m_fuel_total"}},
	"lat":     {Names: []string{"sim/flightmodel/position/latitude"}},
	"lon":     {Names: []string{"sim/flightmodel/position/longitude"}},
	"track":   {Names: []string{"sim/flightmodel/position/hpath"}},
	"wind":    {Names: []string{"sim/weather/aircraft/wind_now_speed_msc", "sim/weather/wind_speed_kt"}},
	"windDir": {Names: []string{"sim/weather/aircraft/wind_now_direction_degt", "sim/weather/wind_direction_degt"}},
	"temp":    {Names: []string{"sim/weather/aircraft/temperature_ambient_deg_c", "sim/weather/temperature_ambient_c"}},
	"press":   {Names: []string{"sim/weather/barometer_sealevel_inhg"}},
	"gear":    {Names: []string{"sim/flightmodel2/gear/deploy_ratio"}, Index: i32(0)},
	"flap":    {Names: []string{"sim/cockpit2/controls/flap_system_deploy_ratio", "sim/flightmodel2/controls/flap_handle_deploy_ratio"}},
	"eng1":    {Names: []string{"sim/flightmodel/engine/ENGN_N1_"}, Index: i32(0)},
	"eng2":    {Names: []string{"sim/flightmodel/engine/ENGN_N1_"}, Index: i32(1)},
}

func i32(v int) *int { return &v }

type State struct {
	Online     bool               `json:"online"`
	XPVersion  string             `json:"xp_version"`
	APIVersion string             `json:"api_version"`
	LocalURL   string             `json:"local_url"`
	IP         string             `json:"ip"`
	LastSeen   int64              `json:"last_seen"`
	Flight     map[string]float64 `json:"flight"`
	Error      string             `json:"error,omitempty"`
}

type Hub struct {
	mu       sync.RWMutex
	log      *appLogger
	started  time.Time
	clients  map[chan string]struct{}
	st       State
	cmdMu    sync.RWMutex
	commands []map[string]any
	ids      map[string]int64
	indices  map[string]*int
	token    string
	license  *LicenseClient
}

type LicenseClient struct {
	mu        sync.RWMutex
	log       *appLogger
	serverURL string
	state     licenseState
}

type licenseState struct {
	TelegramUserID    string `json:"telegram_user_id,omitempty"`
	TelegramFirstName string `json:"telegram_first_name,omitempty"`
	TelegramLastName  string `json:"telegram_last_name,omitempty"`
	TelegramUsername  string `json:"telegram_username,omitempty"`
	DeviceID          string `json:"device_id"`
	DeviceSecret      string `json:"device_secret"`
	LicenseKey        string `json:"license_key"`
	Token             string `json:"token"`
	Plan              string `json:"plan"`
	ExpiresAt         int64  `json:"expires_at"`
	Activated         bool   `json:"activated"`
	LastValidatedAt   int64  `json:"last_validated_at"`
	LastError         string `json:"last_error,omitempty"`
}

const compiledLicenseServerURL = "https://YOUR_LICENSE_SERVER"

func licenseDataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		if u, err := os.UserHomeDir(); err == nil {
			base = filepath.Join(u, ".x-tablet")
		} else {
			base = ".x-tablet"
		}
	}
	dir := filepath.Join(base, "X-Tablet")
	_ = os.MkdirAll(dir, 0o700)
	return dir
}
func licenseFilePath() string { return filepath.Join(licenseDataDir(), "license.json") }

func loadLicenseState(logger *appLogger) licenseState {
	b, err := os.ReadFile(licenseFilePath())
	if err == nil {
		var st licenseState
		if json.Unmarshal(b, &st) == nil && st.DeviceID != "" && st.DeviceSecret != "" {
			return st
		}
	}
	secretBytes := make([]byte, 32)
	if _, err := rand.Read(secretBytes); err != nil {
		panic(err)
	}
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	h := sha256.Sum256([]byte(secret))
	device := "XT-" + strings.ToUpper(hex.EncodeToString(h[:])[:20])
	st := licenseState{DeviceID: device, DeviceSecret: secret}
	b2, _ := json.MarshalIndent(st, "", "  ")
	_ = os.WriteFile(licenseFilePath(), b2, 0o600)
	if logger != nil {
		logger.Infof("License identity created: device=%s", device)
	}
	return st
}

func (lc *LicenseClient) saveLocked() {
	b, _ := json.MarshalIndent(lc.state, "", "  ")
	_ = os.WriteFile(licenseFilePath(), b, 0o600)
}

func newLicenseClient(logger *appLogger) *LicenseClient {
	server := strings.TrimRight(strings.TrimSpace(os.Getenv("XTABLET_LICENSE_SERVER")), "/")
	if server == "" {
		if exe, err := os.Executable(); err == nil {
			b, readErr := os.ReadFile(filepath.Join(filepath.Dir(exe), "license-server.txt"))
			if readErr == nil {
				server = strings.TrimRight(strings.TrimSpace(string(b)), "/")
			}
		}
	}
	if server == "" {
		server = compiledLicenseServerURL
	}
	return &LicenseClient{log: logger, serverURL: server, state: loadLicenseState(logger)}
}

func (lc *LicenseClient) snapshot() licenseState {
	lc.mu.RLock()
	defer lc.mu.RUnlock()
	return lc.state
}

func (lc *LicenseClient) post(path string, body any, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, lc.serverURL+path, strings.NewReader(string(b)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("license server %s: %s", resp.Status, string(rb))
	}
	if out != nil && len(rb) > 0 {
		return json.Unmarshal(rb, out)
	}
	return nil
}

func (lc *LicenseClient) startTelegramLink() (string, string, error) {
	st := lc.snapshot()
	var out struct {
		Code   string `json:"code"`
		BotURL string `json:"botUrl"`
	}
	if err := lc.post("/v1/device/link/start", map[string]any{"deviceId": st.DeviceID}, &out); err != nil {
		return "", "", err
	}
	return out.Code, out.BotURL, nil
}

func (lc *LicenseClient) pollTelegramLink(code string) (bool, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return false, fmt.Errorf("link code required")
	}
	req, err := http.NewRequest(http.MethodGet, lc.serverURL+"/v1/device/link/status/"+url.PathEscape(code), nil)
	if err != nil {
		return false, err
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, fmt.Errorf("link status %s: %s", resp.Status, string(rb))
	}
	var out struct {
		Status  string `json:"status"`
		Profile struct {
			TelegramUserID string `json:"telegramUserId"`
			FirstName      string `json:"firstName"`
			LastName       string `json:"lastName"`
			Username       string `json:"username"`
			Plan           string `json:"plan"`
			ExpiresAt      int64  `json:"expiresAt"`
			Active         bool   `json:"active"`
		} `json:"profile"`
	}
	if err := json.Unmarshal(rb, &out); err != nil {
		return false, err
	}
	if out.Status != "linked" {
		return false, nil
	}
	lc.mu.Lock()
	lc.state.TelegramUserID = out.Profile.TelegramUserID
	lc.state.TelegramFirstName = out.Profile.FirstName
	lc.state.TelegramLastName = out.Profile.LastName
	lc.state.TelegramUsername = out.Profile.Username
	lc.state.LastError = ""
	lc.saveLocked()
	lc.mu.Unlock()
	return true, nil
}

func (lc *LicenseClient) claimTelegramLink(code string) error {
	st := lc.snapshot()
	var out struct {
		Token  string `json:"token"`
		Public struct {
			Plan       string `json:"plan"`
			LicenseKey string `json:"licenseKey"`
			ExpiresAt  int64  `json:"expiresAt"`
		} `json:"public"`
		Profile struct {
			TelegramUserID string `json:"telegramUserId"`
			FirstName      string `json:"firstName"`
			LastName       string `json:"lastName"`
			Username       string `json:"username"`
		} `json:"profile"`
	}
	if err := lc.post("/v1/device/link/claim", map[string]any{"code": code, "deviceId": st.DeviceID, "deviceSecret": st.DeviceSecret}, &out); err != nil {
		return err
	}
	lc.mu.Lock()
	lc.state.TelegramUserID = out.Profile.TelegramUserID
	lc.state.TelegramFirstName = out.Profile.FirstName
	lc.state.TelegramLastName = out.Profile.LastName
	lc.state.TelegramUsername = out.Profile.Username
	lc.state.LicenseKey = out.Public.LicenseKey
	lc.state.Token = out.Token
	lc.state.Plan = out.Public.Plan
	lc.state.ExpiresAt = out.Public.ExpiresAt
	lc.state.Activated = true
	lc.state.LastValidatedAt = time.Now().Unix()
	lc.state.LastError = ""
	lc.saveLocked()
	lc.mu.Unlock()
	if lc.log != nil {
		lc.log.Infof("Telegram account linked: user=%s plan=%s", out.Profile.TelegramUserID, out.Public.Plan)
	}
	return nil
}

func (lc *LicenseClient) activate(key string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return fmt.Errorf("license key required")
	}
	var out struct {
		Token  string `json:"token"`
		Public struct {
			Plan       string `json:"plan"`
			LicenseKey string `json:"licenseKey"`
			ExpiresAt  int64  `json:"expiresAt"`
		} `json:"public"`
	}
	st := lc.snapshot()
	if err := lc.post("/v1/license/activate", map[string]any{"licenseKey": key, "deviceId": st.DeviceID, "deviceSecret": st.DeviceSecret}, &out); err != nil {
		lc.mu.Lock()
		lc.state.LastError = err.Error()
		lc.mu.Unlock()
		if lc.log != nil {
			lc.log.Warnf("License activation failed: %v", err)
		}
		return err
	}
	lc.mu.Lock()
	lc.state.LicenseKey = out.Public.LicenseKey
	lc.state.Token = out.Token
	lc.state.Plan = out.Public.Plan
	lc.state.ExpiresAt = out.Public.ExpiresAt
	lc.state.Activated = true
	lc.state.LastValidatedAt = time.Now().Unix()
	lc.state.LastError = ""
	lc.saveLocked()
	lc.mu.Unlock()
	if lc.log != nil {
		lc.log.Infof("License activated: plan=%s expires=%d", out.Public.Plan, out.Public.ExpiresAt)
	}
	return nil
}

func (lc *LicenseClient) heartbeat() {
	for {
		time.Sleep(10 * time.Minute)
		st := lc.snapshot()
		if !st.Activated || st.Token == "" {
			continue
		}
		var out struct {
			Token  string `json:"token"`
			Public struct {
				Plan       string `json:"plan"`
				LicenseKey string `json:"licenseKey"`
				ExpiresAt  int64  `json:"expiresAt"`
			} `json:"public"`
		}
		err := lc.post("/v1/license/heartbeat", map[string]any{"token": st.Token, "deviceId": st.DeviceID, "deviceSecret": st.DeviceSecret}, &out)
		lc.mu.Lock()
		if err != nil {
			lc.state.LastError = err.Error()
		} else {
			lc.state.Token = out.Token
			lc.state.Plan = out.Public.Plan
			lc.state.LicenseKey = out.Public.LicenseKey
			lc.state.ExpiresAt = out.Public.ExpiresAt
			lc.state.LastValidatedAt = time.Now().Unix()
			lc.state.LastError = ""
			lc.saveLocked()
		}
		lc.mu.Unlock()
		if err != nil && lc.log != nil {
			lc.log.Warnf("License heartbeat failed: %v", err)
		}
	}
}

func newHub(token string, l *appLogger, license *LicenseClient) *Hub {
	return &Hub{log: l, started: time.Now(), clients: map[chan string]struct{}{}, st: State{Flight: map[string]float64{}}, ids: map[string]int64{}, indices: map[string]*int{}, token: token, license: license}
}

func (h *Hub) snapshot() State {
	h.mu.RLock()
	defer h.mu.RUnlock()
	cp := State{Online: h.st.Online, XPVersion: h.st.XPVersion, APIVersion: h.st.APIVersion, LocalURL: h.st.LocalURL, IP: h.st.IP, LastSeen: h.st.LastSeen, Flight: map[string]float64{}, Error: h.st.Error}
	for k, v := range h.st.Flight {
		cp.Flight[k] = v
	}
	return cp
}
func (h *Hub) publish(kind string, payload any) {
	b, _ := json.Marshal(map[string]any{"type": kind, "data": payload})
	s := string(b)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		select {
		case c <- s:
		default:
		}
	}
}
func (h *Hub) add(c chan string) { h.mu.Lock(); h.clients[c] = struct{}{}; h.mu.Unlock() }
func (h *Hub) remove(c chan string) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c)
	}
	h.mu.Unlock()
}

func xpGET(base, path string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	cl := &http.Client{Timeout: 5 * time.Second}
	r, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	if r.StatusCode < 200 || r.StatusCode >= 300 {
		return nil, fmt.Errorf("x-plane http %s: %s", r.Status, string(b))
	}
	return b, nil
}
func xpPOST(base, path string, body any) ([]byte, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, base+path, strings.NewReader(string(b)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	cl := &http.Client{Timeout: 5 * time.Second}
	r, err := cl.Do(req)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	bb, _ := io.ReadAll(r.Body)
	if r.StatusCode < 200 || r.StatusCode >= 300 {
		return nil, fmt.Errorf("x-plane http %s: %s", r.Status, string(bb))
	}
	return bb, nil
}

func chooseAPI(versions []string) string {
	has := map[string]bool{}
	for _, v := range versions {
		has[v] = true
	}
	for _, v := range []string{"v3", "v2", "v1"} {
		if has[v] {
			return v
		}
	}
	return ""
}
func capabilities() (version string, api string, err error) {
	// X-Plane 12.1.4+ exposes /api/capabilities (v2+). For 12.1.1-12.1.3
	// we fall back to probing versioned endpoints because capabilities did not exist yet.
	if b, e := xpGET("http://127.0.0.1:8086", "/api/capabilities"); e == nil {
		var c struct {
			API struct {
				Versions []string `json:"versions"`
			} `json:"api"`
			XP struct {
				Version string `json:"version"`
			} `json:"x-plane"`
		}
		if e = json.Unmarshal(b, &c); e == nil {
			if v := chooseAPI(c.API.Versions); v != "" {
				return c.XP.Version, v, nil
			}
		}
	}

	for _, v := range []string{"v3", "v2", "v1"} {
		if _, e := xpGET("http://127.0.0.1:8086", "/api/"+v+"/datarefs?limit=1&fields=id,name,value_type"); e == nil {
			return "", v, nil
		}
	}
	return "", "", fmt.Errorf("X-Plane Web API not available")
}

func findDatarefIDs(base string) (map[string]int64, map[string]*int, map[string]string, error) {
	q := url.Values{}
	allNames := make([]string, 0, len(datarefSpecs)*2)
	seen := map[string]bool{}
	for _, s := range datarefSpecs {
		for _, name := range s.Names {
			if !seen[name] {
				seen[name] = true
				allNames = append(allNames, name)
			}
		}
	}
	sort.Strings(allNames)
	for _, n := range allNames {
		q.Add("filter[name]", n)
	}
	b, e := xpGET(base, "/datarefs?"+q.Encode())
	if e != nil {
		return nil, nil, nil, e
	}
	var dr struct {
		Data []struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	}
	if e = json.Unmarshal(b, &dr); e != nil {
		return nil, nil, nil, e
	}
	by := map[string]int64{}
	for _, x := range dr.Data {
		by[x.Name] = x.ID
	}
	ids := map[string]int64{}
	idx := map[string]*int{}
	chosen := map[string]string{}
	for key, s := range datarefSpecs {
		for _, name := range s.Names {
			if id, ok := by[name]; ok {
				ids[key] = id
				idx[key] = s.Index
				chosen[key] = name
				break
			}
		}
	}
	return ids, idx, chosen, nil
}

func wsLoop(h *Hub) {
	if h.log != nil {
		h.log.Infof("X-Plane connection loop started; target=%s", xpHost)
	}
	for {
		ver, api, e := capabilities()
		if e != nil {
			if h.log != nil {
				h.log.Warnf("X-Plane discovery failed: %v", e)
			}
			h.mu.Lock()
			h.st.Online = false
			h.st.Error = "X‑Plane не найден"
			h.mu.Unlock()
			h.publish("status", h.snapshot())
			time.Sleep(2 * time.Second)
			continue
		}
		if api == "" {
			h.mu.Lock()
			h.st.Online = false
			h.st.Error = "X‑Plane API не поддерживается"
			h.mu.Unlock()
			h.publish("status", h.snapshot())
			time.Sleep(3 * time.Second)
			continue
		}
		base := "http://127.0.0.1:8086/api/" + api
		ids, idx, chosen, e := findDatarefIDs(base)
		if e != nil {
			h.mu.Lock()
			h.st.Online = true
			h.st.XPVersion = ver
			h.st.APIVersion = api
			h.st.Error = "DataRef не удалось получить"
			h.mu.Unlock()
			h.publish("status", h.snapshot())
			time.Sleep(2 * time.Second)
			continue
		}
		if len(ids) == 0 {
			h.mu.Lock()
			h.st.Online = true
			h.st.XPVersion = ver
			h.st.APIVersion = api
			h.st.Error = "Нужные DataRef не найдены"
			h.mu.Unlock()
			h.publish("status", h.snapshot())
			time.Sleep(2 * time.Second)
			continue
		}
		h.mu.Lock()
		h.st.Online = true
		h.st.XPVersion = ver
		h.st.APIVersion = api
		h.st.Error = ""
		h.st.LastSeen = time.Now().UnixMilli()
		h.ids = ids
		h.indices = idx
		h.mu.Unlock()
		h.publish("status", h.snapshot())
		ws, e := wsDial(xpHost, "/api/"+api)
		if e != nil {
			if h.log != nil {
				h.log.Warnf("X-Plane WebSocket connect failed: %v", e)
			}
			h.mu.Lock()
			h.st.Error = "WebSocket X‑Plane не подключён"
			h.mu.Unlock()
			h.publish("status", h.snapshot())
			time.Sleep(1 * time.Second)
			continue
		}
		sub := make([]map[string]any, 0, len(ids))
		for key, id := range ids {
			item := map[string]any{"id": id}
			if x := idx[key]; x != nil {
				item["index"] = *x
			}
			sub = append(sub, item)
		}
		msg := map[string]any{"req_id": 1, "type": "dataref_subscribe_values", "params": map[string]any{"datarefs": sub}}
		j, _ := json.Marshal(msg)
		if e = ws.sendText(string(j)); e != nil {
			if h.log != nil {
				h.log.Warnf("X-Plane DataRef subscription send failed: %v", e)
			}
			ws.close()
			continue
		}
		if h.log != nil {
			h.log.Infof("Subscribed to %d DataRefs on %s", len(sub), api)
		}
		subscribed := false
		for {
			op, p, e := ws.readMessage()
			if e != nil {
				if h.log != nil {
					h.log.Warnf("X-Plane WebSocket read failed: %v", e)
				}
				ws.close()
				h.mu.Lock()
				h.st.Online = false
				h.st.Error = "Соединение с X‑Plane потеряно"
				h.mu.Unlock()
				h.publish("status", h.snapshot())
				// Avoid a reconnect/logging storm if the simulator closes the socket.
				time.Sleep(1 * time.Second)
				break
			}
			switch op {
			case 0x9:
				_ = ws.sendFrame(0xA, p)
				continue
			case 0x8:
				ws.close()
				break
			case 0xA:
				continue
			case 0x1:
			default:
				continue
			}
			var m map[string]any
			if json.Unmarshal(p, &m) != nil {
				continue
			}
			typ, _ := m["type"].(string)
			if typ == "result" {
				if ok, _ := m["success"].(bool); ok {
					subscribed = true
				} else {
					subscribed = false
					h.mu.Lock()
					h.st.Error = "X‑Plane отклонил подписку DataRef"
					h.mu.Unlock()
					h.publish("status", h.snapshot())
				}
				continue
			}
			if typ != "dataref_update_values" {
				continue
			}
			if !subscribed {
				continue
			}
			vals, _ := m["data"].(map[string]any)
			changed := false
			h.mu.Lock()
			for key, id := range ids {
				if raw, ok := vals[strconv.FormatInt(id, 10)]; ok {
					if f, ok := scalarDataRefValue(raw); ok {
						name := chosen[key]
						if key == "gs" {
							f *= 1.943844492
						}
						if key == "wind" && name == "sim/weather/aircraft/wind_now_speed_msc" {
							f *= 1.943844492
						}
						h.st.Flight[key] = f
						changed = true
					}
				}
			}
			h.st.LastSeen = time.Now().UnixMilli()
			h.mu.Unlock()
			if changed {
				h.publish("flight", h.snapshot().Flight)
			}
		}
	}
}

func scalarDataRefValue(raw any) (float64, bool) {
	switch v := raw.(type) {
	case float64:
		return v, true
	case []any:
		if len(v) == 0 {
			return 0, false
		}
		f, ok := v[0].(float64)
		return f, ok
	default:
		return 0, false
	}
}

func loadCommands(h *Hub) {
	for {
		st := h.snapshot()
		if !st.Online || st.APIVersion < "v2" {
			time.Sleep(2 * time.Second)
			continue
		}
		all := make([]map[string]any, 0, 4096)
		start := 0
		base := "http://127.0.0.1:8086/api/" + st.APIVersion
		for {
			b, e := xpGET(base, fmt.Sprintf("/commands?start=%d&limit=500&fields=id,name,description", start))
			if e != nil {
				break
			}
			var r struct {
				Data []map[string]any `json:"data"`
			}
			if json.Unmarshal(b, &r) != nil || len(r.Data) == 0 {
				break
			}
			all = append(all, r.Data...)
			start += len(r.Data)
			if len(r.Data) < 500 || start >= 20000 {
				break
			}
		}
		if len(all) > 0 {
			h.cmdMu.Lock()
			h.commands = all
			h.cmdMu.Unlock()
			h.publish("commands", all)
		}
		time.Sleep(10 * time.Second)
	}
}

func tokenOK(h *Hub, r *http.Request) bool {
	if r.URL.Query().Get("token") == h.token || r.Header.Get("X-XTablet-Token") == h.token {
		return true
	}
	c, err := r.Cookie("xt_token")
	return err == nil && c.Value == h.token
}
func requireToken(h *Hub, w http.ResponseWriter, r *http.Request) bool {
	if tokenOK(h, r) {
		return true
	}
	http.Error(w, "unauthorized", http.StatusUnauthorized)
	return false
}

func apiLicenseStatus(h *Hub, w http.ResponseWriter, r *http.Request) {
	if !requireToken(h, w, r) {
		return
	}
	if h.license == nil {
		http.Error(w, "license unavailable", 500)
		return
	}
	st := h.license.snapshot()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"server_url":          h.license.serverURL,
		"device_id":           st.DeviceID,
		"activated":           st.Activated,
		"plan":                st.Plan,
		"expires_at":          st.ExpiresAt,
		"license_key":         st.LicenseKey,
		"last_validated_at":   st.LastValidatedAt,
		"last_error":          st.LastError,
		"telegram_user_id":    st.TelegramUserID,
		"telegram_first_name": st.TelegramFirstName,
		"telegram_last_name":  st.TelegramLastName,
		"telegram_username":   st.TelegramUsername,
	})
}

func apiLicenseActivate(h *Hub, w http.ResponseWriter, r *http.Request) {
	if !requireToken(h, w, r) {
		return
	}
	if h.license == nil {
		http.Error(w, "license unavailable", 500)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var p struct {
		LicenseKey string `json:"license_key"`
	}
	if json.NewDecoder(r.Body).Decode(&p) != nil || strings.TrimSpace(p.LicenseKey) == "" {
		http.Error(w, "license_key_required", 400)
		return
	}
	if err := h.license.activate(p.LicenseKey); err != nil {
		http.Error(w, err.Error(), 403)
		return
	}
	apiLicenseStatus(h, w, r)
}

func apiStatus(h *Hub, w http.ResponseWriter, r *http.Request) {
	if !requireToken(h, w, r) {
		return
	}
	if t := r.URL.Query().Get("token"); t == h.token {
		http.SetCookie(w, &http.Cookie{Name: "xt_token", Value: t, Path: "/", SameSite: http.SameSiteLaxMode, HttpOnly: true})
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(h.snapshot())
}
func apiCommands(h *Hub, w http.ResponseWriter, r *http.Request) {
	if !requireToken(h, w, r) {
		return
	}
	h.cmdMu.RLock()
	defer h.cmdMu.RUnlock()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{"data": h.commands})
}
func apiActivate(h *Hub, w http.ResponseWriter, r *http.Request) {
	if !requireToken(h, w, r) {
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var p struct {
		Name     string  `json:"name"`
		Duration float64 `json:"duration"`
	}
	if json.NewDecoder(r.Body).Decode(&p) != nil || p.Name == "" {
		http.Error(w, "bad request", 400)
		return
	}
	h.cmdMu.RLock()
	var id int64
	for _, c := range h.commands {
		if name, _ := c["name"].(string); name == p.Name {
			switch n := c["id"].(type) {
			case float64:
				id = int64(n)
			case int64:
				id = n
			}
			break
		}
	}
	h.cmdMu.RUnlock()
	if id == 0 {
		if h.log != nil {
			h.log.Warnf("Command not found: %s", p.Name)
		}
		http.Error(w, "command not found", 404)
		return
	}
	st := h.snapshot()
	if st.APIVersion < "v2" {
		http.Error(w, "X‑Plane API v2+ required", 503)
		return
	}
	duration := clamp(p.Duration, 0, 10)
	if _, e := xpPOST("http://127.0.0.1:8086/api/"+st.APIVersion, fmt.Sprintf("/command/%d/activate", id), map[string]any{"duration": duration}); e != nil {
		if h.log != nil {
			h.log.Warnf("Command failed: name=%s id=%d duration=%.2f err=%v", p.Name, id, duration, e)
		}
		http.Error(w, e.Error(), 503)
		return
	}
	if h.log != nil {
		h.log.Infof("Command sent: name=%s id=%d duration=%.2f", p.Name, id, duration)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
func clamp(v, a, b float64) float64 {
	if v < a {
		return a
	}
	if v > b {
		return b
	}
	return v
}

func events(h *Hub, w http.ResponseWriter, r *http.Request) {
	if !requireToken(h, w, r) {
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", 500)
		return
	}
	c := make(chan string, 128)
	h.add(c)
	defer h.remove(c)
	send := func(s string) { _, _ = fmt.Fprintf(w, "data: %s\n\n", s); fl.Flush() }
	st, _ := json.Marshal(map[string]any{"type": "status", "data": h.snapshot()})
	send(string(st))
	for {
		select {
		case <-r.Context().Done():
			return
		case s := <-c:
			send(s)
		}
	}
}

func apiDiagnostics(h *Hub, w http.ResponseWriter, r *http.Request) {
	if !requireToken(h, w, r) {
		return
	}
	st := h.snapshot()
	lastAge := int64(-1)
	if st.LastSeen > 0 {
		lastAge = time.Now().UnixMilli() - st.LastSeen
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"app":              "X-Tablet",
		"uptime_seconds":   int64(time.Since(h.started).Seconds()),
		"xplane":           st,
		"last_data_age_ms": lastAge,
		"log_path": func() string {
			if h.log != nil {
				return h.log.path
			}
			return ""
		}(),
	})
}

func apiLogs(h *Hub, w http.ResponseWriter, r *http.Request) {
	if !requireToken(h, w, r) {
		return
	}
	if h.log == nil {
		http.Error(w, "logging unavailable", 500)
		return
	}
	n := 120
	if v, err := strconv.Atoi(r.URL.Query().Get("n")); err == nil && v > 0 {
		if v > 500 {
			v = 500
		}
		n = v
	}
	b, err := os.ReadFile(h.log.path)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	lines := strings.Split(strings.TrimRight(string(b), "\r\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{"path": h.log.path, "lines": lines})
}

func localIPs() []string {
	var out []string
	seen := map[string]bool{}
	ifs, _ := net.Interfaces()
	for _, in := range ifs {
		if in.Flags&net.FlagUp == 0 || in.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := in.Addrs()
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.To4() == nil {
				continue
			}
			s := ip.To4().String()
			if isPrivateIPv4(s) && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	sort.Strings(out)
	return out
}
func isPrivateIPv4(s string) bool {
	ip := net.ParseIP(s)
	if ip == nil {
		return false
	}
	v := ip.To4()
	return v[0] == 10 || (v[0] == 172 && v[1] >= 16 && v[1] <= 31) || (v[0] == 192 && v[1] == 168)
}
func chooseBindIP() string {
	xs := localIPs()
	if len(xs) > 0 {
		return xs[0]
	}
	return "127.0.0.1"
}
func chooseAddr(start int) (string, error) {
	for p := start; p < start+20; p++ {
		ln, e := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", p))
		if e == nil {
			_ = ln.Close()
			return fmt.Sprintf("0.0.0.0:%d", p), nil
		}
	}
	return "", fmt.Errorf("no free port")
}
func openBrowser(u string) {
	if runtime.GOOS == "windows" {
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", u).Start()
	} else if runtime.GOOS == "darwin" {
		_ = exec.Command("open", u).Start()
	} else {
		_ = exec.Command("xdg-open", u).Start()
	}
}

//go:embed web/*
var webFS embed.FS

func newToken() string {
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}

func main() {
	logger, err := newAppLogger()
	if err != nil {
		logger = &appLogger{Logger: log.New(os.Stderr, "", log.LstdFlags|log.Lmicroseconds), path: ""}
	}
	defer logger.Close()
	defer func() {
		if r := recover(); r != nil {
			logger.Errorf("PANIC: %v\n%s", r, debug.Stack())
		}
	}()
	token := newToken()
	license := newLicenseClient(logger)
	h := newHub(token, logger, license)
	logger.Infof("X-Tablet starting; pid=%d", os.Getpid())
	ip := chooseBindIP()
	addr, e := chooseAddr(8787)
	if e != nil {
		log.Fatal(e)
	}
	_, port, _ := net.SplitHostPort(addr)
	h.mu.Lock()
	h.st.IP = ip
	h.st.LocalURL = "http://" + ip + ":" + port + "/?token=" + url.QueryEscape(token)
	h.mu.Unlock()
	go wsLoop(h)
	go loadCommands(h)
	go license.heartbeat()
	mux := http.NewServeMux()
	withRequestLog := func(name string, fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if h.log != nil && !strings.HasPrefix(r.URL.Path, "/events") {
				h.log.Infof("HTTP %s %s", r.Method, name)
			}
			fn(w, r)
		}
	}
	mux.HandleFunc("/api/status", withRequestLog("/api/status", func(w http.ResponseWriter, r *http.Request) { apiStatus(h, w, r) }))
	mux.HandleFunc("/api/commands", withRequestLog("/api/commands", func(w http.ResponseWriter, r *http.Request) { apiCommands(h, w, r) }))
	mux.HandleFunc("/api/commands/activate", withRequestLog("/api/commands/activate", func(w http.ResponseWriter, r *http.Request) { apiActivate(h, w, r) }))
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) { events(h, w, r) })
	mux.HandleFunc("/api/account/start", withRequestLog("/api/account/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		code, botURL, err := h.license.startTelegramLink()
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "bot_url": botURL})
	}))
	mux.HandleFunc("/api/account/poll", withRequestLog("/api/account/poll", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		linked, err := h.license.pollTelegramLink(code)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		st := h.license.snapshot()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{"linked": linked, "telegram_user_id": st.TelegramUserID, "first_name": st.TelegramFirstName, "last_name": st.TelegramLastName, "username": st.TelegramUsername, "plan": st.Plan, "expires_at": st.ExpiresAt, "activated": st.Activated})
	}))
	mux.HandleFunc("/api/account/claim", withRequestLog("/api/account/claim", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if err := h.license.claimTelegramLink(strings.TrimSpace(body.Code)); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	mux.HandleFunc("/api/license/status", withRequestLog("/api/license/status", func(w http.ResponseWriter, r *http.Request) { apiLicenseStatus(h, w, r) }))
	mux.HandleFunc("/api/license/activate", withRequestLog("/api/license/activate", func(w http.ResponseWriter, r *http.Request) { apiLicenseActivate(h, w, r) }))
	mux.HandleFunc("/api/diagnostics", withRequestLog("/api/diagnostics", func(w http.ResponseWriter, r *http.Request) { apiDiagnostics(h, w, r) }))
	mux.HandleFunc("/api/logs", withRequestLog("/api/logs", func(w http.ResponseWriter, r *http.Request) { apiLogs(h, w, r) }))
	mux.HandleFunc("/api/qr", func(w http.ResponseWriter, r *http.Request) {
		if !requireToken(h, w, r) {
			return
		}
		target := h.snapshot().LocalURL
		if strings.Contains(target, "?") {
			target += "&pair=1"
		} else {
			target += "?pair=1"
		}
		png, e := qrcode.Encode(target, qrcode.Medium, 280)
		if e != nil {
			http.Error(w, e.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(png)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		authorized := tokenOK(h, r)
		if r.URL.Path == "/" && r.URL.Query().Get("token") == token {
			http.SetCookie(w, &http.Cookie{Name: "xt_token", Value: token, Path: "/", SameSite: http.SameSiteLaxMode, HttpOnly: true})
			if r.URL.Query().Get("pair") == "1" {
				http.Redirect(w, r, "/?pair=1", http.StatusFound)
			} else {
				http.Redirect(w, r, "/", http.StatusFound)
			}
			return
		}
		if !authorized {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		webRoot, _ := fs.Sub(webFS, "web")
		http.FileServer(http.FS(webRoot)).ServeHTTP(w, r)
	})
	go func() {
		time.Sleep(700 * time.Millisecond)
		openBrowser("http://127.0.0.1:" + port + "/?token=" + url.QueryEscape(token))
	}()
	logger.Infof("X-Tablet ready on %s; local_ip=%s; log=%s", addr, ip, logger.path)
	if e := http.ListenAndServe(addr, mux); e != nil {
		logger.Errorf("HTTP server stopped: %v", e)
	}
}
