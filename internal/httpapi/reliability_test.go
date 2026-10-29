package httpapi_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

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

// TestRenewalFailureDoesNotRejectRequest 覆盖 B7：续期写库失败时，请求仍应按
// 已认证成功处理，而不是返回 500；下一次请求会重新尝试续期。
func TestRenewalFailureDoesNotRejectRequest(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "renew-fail@example.com", "correct horse battery")

	session, err := env.store.LatestSessionForEmail(t.Context(), "renew-fail@example.com")
	if err != nil {
		t.Fatalf("load session: %v", err)
	}
	// 把续期时间推到阈值之外，确保下一次请求会尝试写库。
	if err := env.store.SetSessionTimes(t.Context(), session.ID, session.CreatedAt, time.Now().Add(-2*time.Hour)); err != nil {
		t.Fatalf("age session: %v", err)
	}

	if _, err := env.store.Exec(t.Context(), `
		CREATE OR REPLACE FUNCTION test_fail_session_renew() RETURNS trigger AS $$
		BEGIN
			RAISE EXCEPTION 'simulated renewal failure';
		END;
		$$ LANGUAGE plpgsql`); err != nil {
		t.Fatalf("create trigger function: %v", err)
	}
	if _, err := env.store.Exec(t.Context(), `
		CREATE TRIGGER test_fail_session_renew_trigger
		BEFORE UPDATE ON sessions
		FOR EACH ROW EXECUTE FUNCTION test_fail_session_renew()`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}
	t.Cleanup(func() {
		_, _ = env.store.Exec(context.Background(), `DROP TRIGGER IF EXISTS test_fail_session_renew_trigger ON sessions`)
		_, _ = env.store.Exec(context.Background(), `DROP FUNCTION IF EXISTS test_fail_session_renew()`)
	})

	resp := c.do(http.MethodGet, "/api/v1/auth/me", "")
	if resp.status != http.StatusOK {
		t.Fatalf("request with failed renewal = %d %s", resp.status, resp.body)
	}
	if resp.header.Get("Set-Cookie") != "" {
		t.Fatal("failed renewal must not emit a new cookie")
	}

	if _, err := env.store.Exec(t.Context(), `DROP TRIGGER test_fail_session_renew_trigger ON sessions`); err != nil {
		t.Fatalf("drop trigger: %v", err)
	}
	recovered := c.do(http.MethodGet, "/api/v1/auth/me", "")
	if recovered.status != http.StatusOK {
		t.Fatalf("request after recovery = %d %s", recovered.status, recovered.body)
	}
	if recovered.header.Get("Set-Cookie") == "" {
		t.Fatal("renewal should resume once the database accepts writes")
	}
}
