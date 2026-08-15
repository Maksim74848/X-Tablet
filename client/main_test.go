package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestChooseAPI(t *testing.T) {
	if got := chooseAPI([]string{"v1", "v3", "v2"}); got != "v3" {
		t.Fatalf("got %s", got)
	}
	if got := chooseAPI([]string{"v1"}); got != "v1" {
		t.Fatalf("got %s", got)
	}
	if got := chooseAPI(nil); got != "" {
		t.Fatalf("got %s", got)
	}
}

func TestClampDuration(t *testing.T) {
	if got := clamp(-1, 0, 10); got != 0 {
		t.Fatal(got)
	}
	if got := clamp(2.5, 0, 10); got != 2.5 {
		t.Fatal(got)
	}
	if got := clamp(11, 0, 10); got != 10 {
		t.Fatal(got)
	}
}

func TestLoggerCreatesFile(t *testing.T) {
	base := t.TempDir()
	t.Setenv("LOCALAPPDATA", base)
	l, err := newAppLogger()
	if err != nil {
		t.Fatal(err)
	}
	l.Infof("test event")
	l.Close()
	b, err := os.ReadFile(filepath.Join(base, "X-Tablet", "logs", "x-tablet.log"))
	if err != nil {
		t.Fatal(err)
	}
	if len(b) == 0 {
		t.Fatal("log file empty")
	}
}

func TestDataRefArrayDecode(t *testing.T) {
	v, ok := scalarDataRefValue([]any{12.5})
	if !ok || v != 12.5 {
		t.Fatalf("%v %v", v, ok)
	}
	if _, ok := scalarDataRefValue([]any{}); ok {
		t.Fatal("empty array accepted")
	}
}

func TestAPICapabilitiesShape(t *testing.T) {
	payload := []byte(`{"api":{"versions":["v1","v2","v3"]},"x-plane":{"version":"12.4.0"}}`)
	var c struct {
		API struct {
			Versions []string `json:"versions"`
		} `json:"api"`
		XP struct {
			Version string `json:"version"`
		} `json:"x-plane"`
	}
	if err := json.Unmarshal(payload, &c); err != nil {
		t.Fatal(err)
	}
	if c.XP.Version != "12.4.0" || chooseAPI(c.API.Versions) != "v3" {
		t.Fatalf("bad capabilities %#v", c)
	}
}

func TestUnauthorizedStatus(t *testing.T) {
	h := newHub("secret", nil, nil)
	rr := newTestRecorder()
	req, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1/", nil)
	apiStatus(h, rr, req)
	if rr.status != http.StatusUnauthorized {
		t.Fatalf("status %d", rr.status)
	}
}

type testRecorder struct {
	header http.Header
	status int
}

func newTestRecorder() *testRecorder        { return &testRecorder{header: make(http.Header)} }
func (r *testRecorder) Header() http.Header { return r.header }
func (r *testRecorder) WriteHeader(s int)   { r.status = s }
func (r *testRecorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = 200
	}
	return len(b), nil
}
