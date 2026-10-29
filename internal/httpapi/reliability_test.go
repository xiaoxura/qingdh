package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/XiaoXuRa/qingdh/internal/config"
	"github.com/XiaoXuRa/qingdh/internal/settings"
)

func TestTrustedHostGuardAndEmailLinks(t *testing.T) {
	env := newEnv(t, func(cfg *config.Config, _ *settings.Values) {
		cfg.TrustedHosts = []string{"nav.example.com"}
	})
	c := env.client(t)

	// Disallowed Host is rejected before routing (Host-header poisoning guard).
	if resp := c.do(http.MethodGet, "/healthz", ""); resp.status != http.StatusBadRequest {
		t.Fatalf("untrusted host = %d %s", resp.status, resp.body)
	}
	if resp := c.do(http.MethodGet, "/healthz", "", func(req *http.Request) {
		req.Host = "evil.example.com"
	}); resp.status != http.StatusBadRequest {
		t.Fatalf("spoofed host = %d %s", resp.status, resp.body)
	}

	withHost := func(req *http.Request) {
		req.Host = "nav.example.com"
		req.Header.Set("Origin", "http://nav.example.com")
	}
	if resp := c.do(http.MethodGet, "/healthz", "", withHost); resp.status != http.StatusOK {
		t.Fatalf("trusted host = %d %s", resp.status, resp.body)
	}

	if resp := c.do(http.MethodPost, "/api/v1/auth/register",
		`{"email":"host@example.com","password":"correct horse battery"}`, withHost); resp.status != http.StatusAccepted {
		t.Fatalf("register = %d %s", resp.status, resp.body)
	}
	if resp := c.do(http.MethodPost, "/api/v1/auth/forgot-password",
		`{"email":"host@example.com"}`, withHost); resp.status != http.StatusAccepted {
		t.Fatalf("forgot = %d %s", resp.status, resp.body)
	}

	msg := env.mailer.last()
	if !strings.Contains(msg.Text, "http://nav.example.com/?reset_token=") {
		t.Fatalf("reset link does not use the trusted host: %s", msg.Text)
	}
}

func TestAbsoluteSessionLimitIsDynamic(t *testing.T) {
	env := newEnv(t, func(_ *config.Config, values *settings.Values) {
		values.RequireEmailVerification = false
	})
	c := env.client(t)
	if resp := c.register("absolute@example.com", "correct horse battery"); resp.status != http.StatusCreated {
		t.Fatalf("register = %d %s", resp.status, resp.body)
	}
	if resp := c.do(http.MethodGet, "/api/v1/auth/me", ""); resp.status != http.StatusOK {
		t.Fatalf("me = %d %s", resp.status, resp.body)
	}

	// Simulate a session created 200 days ago while the configured absolute
	// limit is 180 days. Its sliding expiry is still in the future.
	if _, err := env.store.Exec(t.Context(), `
		UPDATE sessions SET created_at = now() - interval '200 days'
		WHERE user_id = (SELECT id FROM users WHERE email = 'absolute@example.com')`); err != nil {
		t.Fatalf("age session: %v", err)
	}

	resp := c.do(http.MethodGet, "/api/v1/auth/me", "")
	if resp.status != http.StatusUnauthorized {
		t.Fatalf("aged session = %d %s", resp.status, resp.body)
	}
}
