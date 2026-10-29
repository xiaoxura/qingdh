package httpapi_test

import (
	"net/http"
	"net/url"
	"testing"
)

func TestFaviconProxyRejectsPrivateAndNonHTTPSchemes(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	for _, target := range []string{
		"http://127.0.0.1:1",
		"http://localhost:8080",
		"http://169.254.169.254",
		"http://10.0.0.1",
		"file:///etc/passwd",
		"javascript:alert(1)",
	} {
		resp := c.do(http.MethodGet, "/api/favicon?u="+url.QueryEscape(target), "")
		if resp.status == http.StatusOK {
			t.Fatalf("SSRF target %q was accepted", target)
		}
	}
}
