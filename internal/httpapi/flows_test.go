package httpapi_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/XiaoXuRa/qingdh/internal/config"
	"github.com/XiaoXuRa/qingdh/internal/settings"
)

func TestRegisterRequiresVerification(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	resp := c.register("User@Example.com", "correct horse battery")
	if resp.status != http.StatusAccepted {
		t.Fatalf("register status = %d, body = %s", resp.status, resp.body)
	}
	if len(c.jar) != 0 {
		t.Fatal("registration must not issue a session before verification")
	}
	if len(env.mailer.messages) != 1 {
		t.Fatalf("expected one email, got %d", len(env.mailer.messages))
	}
	if env.mailer.last().To != "user@example.com" {
		t.Fatalf("email not normalized: %s", env.mailer.last().To)
	}

	// Logging in before verification is refused.
	login := c.login("user@example.com", "correct horse battery")
	if login.status != http.StatusForbidden {
		t.Fatalf("unverified login = %d, body = %s", login.status, login.body)
	}
	if !strings.Contains(login.body, "email_not_verified") {
		t.Fatalf("expected email_not_verified, got %s", login.body)
	}
}

func TestVerifyLinkIssuesSessionAndRenews(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	if resp := c.register("verify@example.com", "correct horse battery"); resp.status != http.StatusAccepted {
		t.Fatalf("register = %d %s", resp.status, resp.body)
	}

	token := env.verifyToken(t)

	// A mail scanner or preview fetching the link must not consume the token.
	page := c.do(http.MethodGet, "/verify-email?token="+token, "")
	if page.status != http.StatusOK || !strings.Contains(page.body, "确认验证") {
		t.Fatalf("verify page = %d, body = %s", page.status, page.body)
	}
	if len(c.jar) != 0 {
		t.Fatal("GET verification page must not issue a session")
	}

	// Only the POST confirmation consumes the token and starts a session.
	link := c.do(http.MethodPost, "/verify-email", "token="+token, func(req *http.Request) {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	})
	if link.status != http.StatusSeeOther {
		t.Fatalf("verify form = %d, body = %s", link.status, link.body)
	}
	if loc := link.header.Get("Location"); !strings.Contains(loc, "verified=1") {
		t.Fatalf("unexpected redirect: %q", loc)
	}
	if len(c.jar) != 1 {
		t.Fatal("verification must issue a session cookie")
	}

	me := c.do(http.MethodGet, "/api/v1/auth/me", "")
	if me.status != http.StatusOK {
		t.Fatalf("me = %d %s", me.status, me.body)
	}
	var payload struct {
		User struct {
			Email         string `json:"email"`
			EmailVerified bool   `json:"emailVerified"`
		} `json:"user"`
		Session struct {
			ExpiresAt time.Time `json:"expiresAt"`
		} `json:"session"`
	}
	if err := json.Unmarshal([]byte(me.body), &payload); err != nil {
		t.Fatalf("decode me: %v", err)
	}
	if !payload.User.EmailVerified || payload.User.Email != "verify@example.com" {
		t.Fatalf("unexpected user: %+v", payload.User)
	}

	// Reusing the link fails: tokens are single use.
	reuse := c.do(http.MethodPost, "/verify-email", "token="+token, func(req *http.Request) {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	})
	if reuse.status != http.StatusSeeOther || !strings.Contains(reuse.header.Get("Location"), "verify=error") {
		t.Fatalf("token reuse should fail, got %d %q", reuse.status, reuse.header.Get("Location"))
	}
}

func TestRegisterWithoutVerificationSwitch(t *testing.T) {
	env := newEnv(t, func(_ *config.Config, v *settings.Values) { v.RequireEmailVerification = false })
	c := env.client(t)

	resp := c.register("open@example.com", "correct horse battery")
	if resp.status != http.StatusCreated {
		t.Fatalf("register = %d %s", resp.status, resp.body)
	}
	if len(c.jar) != 1 {
		t.Fatal("expected a session cookie when verification is disabled")
	}
	if len(env.mailer.messages) != 0 {
		t.Fatalf("no email expected, got %d", len(env.mailer.messages))
	}
}

func TestRegisterValidationAndDuplicates(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	cases := []struct {
		name string
		body string
		want int
	}{
		{"bad email", `{"email":"nope","password":"correct horse"}`, http.StatusUnprocessableEntity},
		{"short password", `{"email":"a@example.com","password":"short"}`, http.StatusUnprocessableEntity},
		{"malformed json", `{"email":`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := c.do(http.MethodPost, "/api/v1/auth/register", tc.body)
			if resp.status != tc.want {
				t.Fatalf("status = %d, body = %s", resp.status, resp.body)
			}
		})
	}

	if resp := c.register("dup@example.com", "correct horse battery"); resp.status != http.StatusAccepted {
		t.Fatalf("first register = %d %s", resp.status, resp.body)
	}
	if resp := c.register("dup@example.com", "correct horse battery"); resp.status != http.StatusConflict {
		t.Fatalf("duplicate register = %d %s", resp.status, resp.body)
	}
}

func TestLoginFlowAndCSRF(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	c.register("login@example.com", "correct horse battery")
	token := env.verifyToken(t)
	if resp := c.verifyEmail(token); resp.status != http.StatusSeeOther {
		t.Fatalf("verify = %d", resp.status)
	}
	c.jar = nil // start a fresh browser

	if resp := c.login("login@example.com", "wrong password"); resp.status != http.StatusUnauthorized {
		t.Fatalf("wrong password = %d %s", resp.status, resp.body)
	}
	if resp := c.login("login@example.com", "correct horse battery"); resp.status != http.StatusOK {
		t.Fatalf("login = %d %s", resp.status, resp.body)
	}
	if len(c.jar) != 1 {
		t.Fatal("login should set a session cookie")
	}

	// Cross-site Origin is rejected.
	cross := c.do(http.MethodPost, "/api/v1/auth/logout", "",
		func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") })
	if cross.status != http.StatusForbidden || !strings.Contains(cross.body, "cross_origin") {
		t.Fatalf("cross origin = %d %s", cross.status, cross.body)
	}

	out := c.do(http.MethodPost, "/api/v1/auth/logout", "")
	if out.status != http.StatusOK {
		t.Fatalf("logout = %d %s", out.status, out.body)
	}
	if resp := c.do(http.MethodGet, "/api/v1/auth/me", ""); resp.status != http.StatusUnauthorized {
		t.Fatalf("me after logout = %d %s", resp.status, resp.body)
	}
}

func TestSessionRenewal(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	c.register("renew@example.com", "correct horse battery")
	if resp := c.verifyEmail(env.verifyToken(t)); resp.status != http.StatusSeeOther {
		t.Fatalf("verify = %d", resp.status)
	}

	session, err := env.store.LatestSessionForEmail(t.Context(), "renew@example.com")
	if err != nil {
		t.Fatalf("load session: %v", err)
	}
	originalExpiry := session.ExpiresAt

	// A fresh session is not renewed on the next request.
	before := c.do(http.MethodGet, "/api/v1/auth/me", "")
	if before.header.Get("Set-Cookie") != "" {
		t.Fatal("session should not be renewed immediately")
	}

	// Age the renewal timestamp past the threshold.
	if err := env.store.SetSessionTimes(t.Context(), session.ID, session.CreatedAt, time.Now().Add(-2*time.Hour)); err != nil {
		t.Fatalf("age session: %v", err)
	}

	renewed := c.do(http.MethodGet, "/api/v1/auth/me", "")
	if renewed.status != http.StatusOK {
		t.Fatalf("me = %d %s", renewed.status, renewed.body)
	}
	if renewed.header.Get("Set-Cookie") == "" {
		t.Fatal("expected a refreshed session cookie")
	}

	again, err := env.store.LatestSessionForEmail(t.Context(), "renew@example.com")
	if err != nil {
		t.Fatalf("reload session: %v", err)
	}
	if !again.ExpiresAt.After(originalExpiry) {
		t.Fatalf("expiry not extended: %s -> %s", originalExpiry, again.ExpiresAt)
	}
	if again.LastRenewedAt.Before(session.LastRenewedAt) {
		t.Fatal("last_renewed_at went backwards")
	}
}

func TestSessionAbsoluteCap(t *testing.T) {
	env := newEnv(t, func(_ *config.Config, v *settings.Values) {
		v.SessionIdleSeconds = int64(10 * 24 * time.Hour / time.Second)
		v.SessionAbsoluteSeconds = int64(10 * 24 * time.Hour / time.Second)
		v.SessionRenewSeconds = 60
	})
	c := env.client(t)

	c.register("cap@example.com", "correct horse battery")
	if resp := c.verifyEmail(env.verifyToken(t)); resp.status != http.StatusSeeOther {
		t.Fatalf("verify = %d", resp.status)
	}
	session, err := env.store.LatestSessionForEmail(t.Context(), "cap@example.com")
	if err != nil {
		t.Fatalf("load session: %v", err)
	}

	// Pretend the session was created before the absolute limit.
	if err := env.store.SetSessionTimes(t.Context(), session.ID, time.Now().Add(-11*24*time.Hour), time.Now().Add(-2*time.Hour)); err != nil {
		t.Fatalf("age session: %v", err)
	}

	// 超过绝对期限的会话必须立即失效，而不是“再放行一次、只是不续期”。
	resp := c.do(http.MethodGet, "/api/v1/auth/me", "")
	if resp.status != http.StatusUnauthorized {
		t.Fatalf("me = %d %s", resp.status, resp.body)
	}
	if resp.header.Get("Set-Cookie") != "" {
		t.Fatal("expired session must not be renewed")
	}
}

func TestWorkspaceSync(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	c.register("sync@example.com", "correct horse battery")
	c.verifyEmail(env.verifyToken(t))

	got := c.do(http.MethodGet, "/api/v1/workspace", "")
	if got.status != http.StatusOK {
		t.Fatalf("get workspace = %d %s", got.status, got.body)
	}
	var initial struct {
		Revision int64           `json:"revision"`
		Payload  json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal([]byte(got.body), &initial); err != nil {
		t.Fatalf("decode workspace: %v", err)
	}
	if initial.Revision != 0 {
		t.Fatalf("initial revision = %d", initial.Revision)
	}

	payload := `{"version":2,"settings":{"name":"小夏","engine":"bing"},"groups":[{"id":"g1","name":"常用","links":[{"id":"l1","title":"GitHub","url":"https://github.com/"}]}]}`
	put := c.do(http.MethodPut, "/api/v1/workspace", fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, payload))
	if put.status != http.StatusOK {
		t.Fatalf("put = %d %s", put.status, put.body)
	}

	// Same base revision again conflicts and returns the current document.
	conflict := c.do(http.MethodPut, "/api/v1/workspace", fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, payload))
	if conflict.status != http.StatusConflict {
		t.Fatalf("conflict = %d %s", conflict.status, conflict.body)
	}
	if !strings.Contains(conflict.body, `"revision":1`) || !strings.Contains(conflict.body, `"current"`) {
		t.Fatalf("conflict body = %s", conflict.body)
	}

	// Next revision succeeds.
	put2 := c.do(http.MethodPut, "/api/v1/workspace", fmt.Sprintf(`{"baseRevision":1,"payload":%s}`, payload))
	if put2.status != http.StatusOK {
		t.Fatalf("put2 = %d %s", put2.status, put2.body)
	}
}

func TestWorkspaceAcceptsEncryptedEnvelope(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "encrypted@example.com", "correct horse battery")

	b64 := func(n int) string {
		return base64.StdEncoding.EncodeToString(make([]byte, n))
	}
	envelope := fmt.Sprintf(`{"version":3,"encrypted":true,"kdf":"pbkdf2-sha256","iterations":600000,"salt":%q,"wrappedKey":%q,"check":%q,"data":%q,"recovery":{"wrappedKey":%q}}`,
		b64(16), b64(60), b64(32), b64(64), b64(60))

	put := c.do(http.MethodPut, "/api/v1/workspace", fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, envelope))
	if put.status != http.StatusOK {
		t.Fatalf("put encrypted = %d %s", put.status, put.body)
	}

	got := c.do(http.MethodGet, "/api/v1/workspace", "")
	if got.status != http.StatusOK {
		t.Fatalf("get encrypted = %d %s", got.status, got.body)
	}
	var payload struct {
		Payload struct {
			Version   int  `json:"version"`
			Encrypted bool `json:"encrypted"`
		} `json:"payload"`
		Revision int64 `json:"revision"`
	}
	if err := json.Unmarshal([]byte(got.body), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Payload.Version != 3 || !payload.Payload.Encrypted || payload.Revision != 1 {
		t.Fatalf("unexpected encrypted workspace: %+v", payload)
	}

	// Once encrypted, an old client must not be able to overwrite it with
	// plaintext.
	downgrade := c.do(http.MethodPut, "/api/v1/workspace",
		`{"baseRevision":1,"payload":{"version":2,"groups":[]}}`)
	if downgrade.status != http.StatusUnprocessableEntity || !strings.Contains(downgrade.body, "encryption_required") {
		t.Fatalf("downgrade = %d %s", downgrade.status, downgrade.body)
	}
}

func TestWorkspaceValidation(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	c.register("valid@example.com", "correct horse battery")
	c.verifyEmail(env.verifyToken(t))

	cases := []struct {
		name   string
		body   string
		status int
	}{
		{
			name:   "javascript url",
			body:   `{"baseRevision":0,"payload":{"version":2,"groups":[{"id":"g","name":"g","links":[{"id":"l","url":"javascript:alert(1)"}]}]}}`,
			status: http.StatusUnprocessableEntity,
		},
		{
			name:   "unsupported version",
			body:   `{"baseRevision":0,"payload":{"version":1,"groups":[]}}`,
			status: http.StatusUnprocessableEntity,
		},
		{
			name:   "duplicate link ids",
			body:   `{"baseRevision":0,"payload":{"version":2,"groups":[{"id":"g","name":"g","links":[{"id":"l","url":"https://a.com"},{"id":"l","url":"https://b.com"}]}]}}`,
			status: http.StatusUnprocessableEntity,
		},
		{
			name:   "groups not array",
			body:   `{"baseRevision":0,"payload":{"version":2,"groups":{}}}`,
			status: http.StatusUnprocessableEntity,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := c.do(http.MethodPut, "/api/v1/workspace", tc.body)
			if resp.status != tc.status {
				t.Fatalf("status = %d, body = %s", resp.status, resp.body)
			}
		})
	}
}

func TestDeleteSessionIsIdempotent(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "session-delete@example.com", "correct horse battery")

	id := "00000000-0000-0000-0000-000000000001"
	for i := 0; i < 2; i++ {
		resp := c.do(http.MethodDelete, "/api/v1/auth/sessions/"+id, "")
		if resp.status != http.StatusOK {
			t.Fatalf("delete %d = %d %s", i, resp.status, resp.body)
		}
	}
}

func TestRepeatedLoginKeepsOneDevice(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	registerVerified(t, env, c, "device@example.com", "correct horse battery")
	user, err := env.store.UserByEmail(t.Context(), "device@example.com")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}

	for i := 0; i < 3; i++ {
		if resp := c.login("device@example.com", "correct horse battery"); resp.status != http.StatusOK {
			t.Fatalf("login %d = %d %s", i, resp.status, resp.body)
		}
	}

	sessions, err := env.store.ListSessions(t.Context(), user.ID)
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("repeated logins should keep one device, got %d", len(sessions))
	}

	// A second browser is a genuinely different device.
	other := env.client(t)
	if resp := other.login("device@example.com", "correct horse battery"); resp.status != http.StatusOK {
		t.Fatalf("second browser login = %d %s", resp.status, resp.body)
	}
	sessions, err = env.store.ListSessions(t.Context(), user.ID)
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("two browsers should be two devices, got %d", len(sessions))
	}
}

func TestLoginRemovesLegacyDuplicateSessions(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	registerVerified(t, env, c, "legacy@example.com", "correct horse battery")
	user, err := env.store.UserByEmail(t.Context(), "legacy@example.com")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}

	sessions, err := env.store.ListSessions(t.Context(), user.ID)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("initial sessions = %d, err = %v", len(sessions), err)
	}

	// Simulate a session created before device IDs existed.
	legacyHash := make([]byte, 32)
	legacyHash[0] = 7
	if _, err := env.store.Exec(t.Context(), `
		INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
		VALUES ($1, $2, $3, $4, now() + interval '1 day')`,
		user.ID, legacyHash, sessions[0].UserAgent, sessions[0].IP); err != nil {
		t.Fatalf("insert legacy session: %v", err)
	}

	if resp := c.login("legacy@example.com", "correct horse battery"); resp.status != http.StatusOK {
		t.Fatalf("login = %d %s", resp.status, resp.body)
	}

	sessions, err = env.store.ListSessions(t.Context(), user.ID)
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("legacy duplicate should be removed, got %d", len(sessions))
	}
}

func TestPasswordResetRevokesSessions(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	c.register("reset@example.com", "correct horse battery")
	c.verifyEmail(env.verifyToken(t))
	if len(c.jar) != 1 {
		t.Fatal("expected a session")
	}

	if resp := c.do(http.MethodPost, "/api/v1/auth/forgot-password", `{"email":"reset@example.com"}`); resp.status != http.StatusAccepted {
		t.Fatalf("forgot = %d %s", resp.status, resp.body)
	}
	msg := env.mailer.last()
	idx := strings.Index(msg.Text, "reset_token=")
	if idx == -1 {
		t.Fatalf("reset link missing: %s", msg.Text)
	}
	token := msg.Text[idx+len("reset_token="):]
	if nl := strings.IndexAny(token, "\r\n"); nl >= 0 {
		token = token[:nl]
	}

	if resp := c.do(http.MethodPost, "/api/v1/auth/reset-password", fmt.Sprintf(`{"token":%q,"password":"new password here"}`, token)); resp.status != http.StatusOK {
		t.Fatalf("reset = %d %s", resp.status, resp.body)
	}

	// The old session is revoked and the old password no longer works.
	if resp := c.do(http.MethodGet, "/api/v1/auth/me", ""); resp.status != http.StatusUnauthorized {
		t.Fatalf("me after reset = %d %s", resp.status, resp.body)
	}
	if resp := c.login("reset@example.com", "correct horse battery"); resp.status != http.StatusUnauthorized {
		t.Fatalf("old password = %d %s", resp.status, resp.body)
	}
	if resp := c.login("reset@example.com", "new password here"); resp.status != http.StatusOK {
		t.Fatalf("new password = %d %s", resp.status, resp.body)
	}
}

func TestAccountDeletionCascades(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	c.register("delete@example.com", "correct horse battery")
	c.verifyEmail(env.verifyToken(t))

	wrong := c.do(http.MethodDelete, "/api/v1/account", `{"password":"nope"}`)
	if wrong.status != http.StatusForbidden {
		t.Fatalf("wrong password = %d %s", wrong.status, wrong.body)
	}

	resp := c.do(http.MethodDelete, "/api/v1/account", `{"password":"correct horse battery"}`)
	if resp.status != http.StatusOK {
		t.Fatalf("delete = %d %s", resp.status, resp.body)
	}
	if _, err := env.store.UserByEmail(t.Context(), "delete@example.com"); err == nil {
		t.Fatal("user should be gone")
	}
}

func TestRegistrationCanBeDisabled(t *testing.T) {
	env := newEnv(t, func(_ *config.Config, v *settings.Values) { v.AllowRegistration = false })
	c := env.client(t)

	resp := c.register("closed@example.com", "correct horse battery")
	if resp.status != http.StatusForbidden {
		t.Fatalf("status = %d %s", resp.status, resp.body)
	}
}

// TestWorkspaceRecoversMissingRow 覆盖 B8：documents 行缺失时，GET 有 fallback，
// PUT 也必须能按 revision 0 自愈，而不是永久 409。
func TestWorkspaceRecoversMissingRow(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "self-heal@example.com", "correct horse battery")

	got := c.do(http.MethodGet, "/api/v1/workspace", "")
	if got.status != http.StatusOK {
		t.Fatalf("initial get = %d %s", got.status, got.body)
	}

	user, err := env.store.UserByEmail(t.Context(), "self-heal@example.com")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	if _, err := env.store.Exec(t.Context(), `DELETE FROM documents WHERE user_id = $1`, user.ID); err != nil {
		t.Fatalf("delete document: %v", err)
	}

	payload := `{"version":2,"settings":{},"groups":[{"id":"g1","name":"恢复","links":[]}]}`
	put := c.do(http.MethodPut, "/api/v1/workspace", fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, payload))
	if put.status != http.StatusOK {
		t.Fatalf("put after missing row = %d %s", put.status, put.body)
	}
	if !strings.Contains(put.body, `"revision":1`) {
		t.Fatalf("expected the row to be recreated at revision 1: %s", put.body)
	}

	// 不存在的行 + 非 0 baseRevision 仍然是冲突，不能凭空覆盖。
	if _, err := env.store.Exec(t.Context(), `DELETE FROM documents WHERE user_id = $1`, user.ID); err != nil {
		t.Fatalf("delete document again: %v", err)
	}
	stale := c.do(http.MethodPut, "/api/v1/workspace", fmt.Sprintf(`{"baseRevision":3,"payload":%s}`, payload))
	if stale.status != http.StatusConflict {
		t.Fatalf("stale base on missing row = %d %s", stale.status, stale.body)
	}
}
