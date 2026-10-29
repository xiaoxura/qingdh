package httpapi_test

import (
	"net/http"
	"strings"
	"testing"
)

func staticRequest(t *testing.T, env *testEnv, path string, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, env.server.URL+path, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	client := env.server.Client()
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	if base, ok := transport.(*http.Transport); ok {
		clone := base.Clone()
		clone.DisableCompression = true
		client.Transport = clone
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func TestStaticAssetsUseGzipETagAndImmutableCaching(t *testing.T) {
	env := newEnv(t, nil)

	resp := staticRequest(t, env, "/app.js?v=20261029-29", map[string]string{"Accept-Encoding": "gzip"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q", got)
	}
	etag := resp.Header.Get("ETag")
	if !strings.HasPrefix(etag, `"`) || !strings.HasSuffix(etag, `"`) {
		t.Fatalf("ETag = %q", etag)
	}
	if cache := resp.Header.Get("Cache-Control"); !strings.Contains(cache, "immutable") {
		t.Fatalf("Cache-Control = %q", cache)
	}
	if vary := resp.Header.Get("Vary"); !strings.Contains(vary, "Accept-Encoding") {
		t.Fatalf("Vary = %q", vary)
	}

	notModified := staticRequest(t, env, "/app.js?v=20261029-29", map[string]string{
		"Accept-Encoding": "gzip",
		"If-None-Match":   etag,
	})
	if notModified.StatusCode != http.StatusNotModified {
		t.Fatalf("conditional status = %d", notModified.StatusCode)
	}

	html := staticRequest(t, env, "/", nil)
	if cache := html.Header.Get("Cache-Control"); cache != "no-cache" {
		t.Fatalf("HTML Cache-Control = %q", cache)
	}
	if html.Header.Get("ETag") == "" {
		t.Fatal("HTML ETag is empty")
	}
}

func TestStaticAssetsRejectNonReadMethods(t *testing.T) {
	env := newEnv(t, nil)
	req, err := http.NewRequest(http.MethodPost, env.server.URL+"/app.js", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := env.server.Client().Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}
