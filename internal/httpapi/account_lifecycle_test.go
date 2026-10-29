package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/XiaoXuRa/qingdh/internal/config"
	"github.com/XiaoXuRa/qingdh/internal/settings"
)

func TestChangePasswordValidation(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "change@example.com", "correct horse battery")

	cases := []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{
			name:   "wrong current password",
			body:   `{"currentPassword":"wrong password","newPassword":"another password"}`,
			status: http.StatusForbidden,
			code:   "invalid_password",
		},
		{
			name:   "short new password",
			body:   `{"currentPassword":"correct horse battery","newPassword":"short"}`,
			status: http.StatusUnprocessableEntity,
			code:   "weak_password",
		},
		{
			name:   "same as old password",
			body:   `{"currentPassword":"correct horse battery","newPassword":"correct horse battery"}`,
			status: http.StatusUnprocessableEntity,
			code:   "same_password",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := c.do(http.MethodPost, "/api/v1/auth/password", tc.body)
			if resp.status != tc.status || !strings.Contains(resp.body, tc.code) {
				t.Fatalf("status = %d, body = %s", resp.status, resp.body)
			}
		})
	}

	unauth := env.client(t)
	if resp := unauth.do(http.MethodPost, "/api/v1/auth/password",
		`{"currentPassword":"x","newPassword":"another password"}`); resp.status != http.StatusUnauthorized {
		t.Fatalf("anonymous change = %d %s", resp.status, resp.body)
	}
}

func TestChangePasswordKeepsCurrentSessionAndRevokesOthers(t *testing.T) {
	env := newEnv(t, nil)
	current := env.client(t)
	registerVerified(t, env, current, "rotate@example.com", "correct horse battery")

	other := env.client(t)
	if resp := other.login("rotate@example.com", "correct horse battery"); resp.status != http.StatusOK {
		t.Fatalf("second login = %d %s", resp.status, resp.body)
	}
	if resp := other.do(http.MethodGet, "/api/v1/auth/me", ""); resp.status != http.StatusOK {
		t.Fatalf("other device before change = %d %s", resp.status, resp.body)
	}

	before := len(env.mailer.messages)
	resp := current.do(http.MethodPost, "/api/v1/auth/password",
		`{"currentPassword":"correct horse battery","newPassword":"brand new password"}`)
	if resp.status != http.StatusOK {
		t.Fatalf("change password = %d %s", resp.status, resp.body)
	}

	// 当前会话保留，其他设备退出。
	if me := current.do(http.MethodGet, "/api/v1/auth/me", ""); me.status != http.StatusOK {
		t.Fatalf("current session = %d %s", me.status, me.body)
	}
	if me := other.do(http.MethodGet, "/api/v1/auth/me", ""); me.status != http.StatusUnauthorized {
		t.Fatalf("other session = %d %s", me.status, me.body)
	}

	// 旧密码失效，新密码可用。
	if old := env.client(t).login("rotate@example.com", "correct horse battery"); old.status != http.StatusUnauthorized {
		t.Fatalf("old password = %d %s", old.status, old.body)
	}
	if fresh := env.client(t).login("rotate@example.com", "brand new password"); fresh.status != http.StatusOK {
		t.Fatalf("new password = %d %s", fresh.status, fresh.body)
	}

	// 审计与通知邮件。
	entries, err := env.store.ListAudit(context.Background(), nil, 20)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	found := false
	for _, entry := range entries {
		if entry.Action == "account.password_change" {
			found = true
		}
	}
	if !found {
		t.Fatalf("password change was not audited: %+v", entries)
	}
	if len(env.mailer.messages) != before+1 || !strings.Contains(env.mailer.last().Subject, "密码已修改") {
		t.Fatalf("expected a password changed email, got %+v", env.mailer.messages[before:])
	}
}

func TestChangePasswordRateLimitedPerUser(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "password-limit@example.com", "correct horse battery")

	statuses := make([]int, 0, 4)
	for i := 0; i < 4; i++ {
		resp := c.do(http.MethodPost, "/api/v1/auth/password",
			fmt.Sprintf(`{"currentPassword":"wrong-%d","newPassword":"another password"}`, i))
		statuses = append(statuses, resp.status)
	}
	want := []int{http.StatusForbidden, http.StatusForbidden, http.StatusForbidden, http.StatusTooManyRequests}
	for i := range want {
		if statuses[i] != want[i] {
			t.Fatalf("attempt %d = %d, want %d (all: %v)", i+1, statuses[i], want[i], statuses)
		}
	}
}

func extractMailToken(t *testing.T, text, marker string) string {
	t.Helper()
	idx := strings.Index(text, marker)
	if idx == -1 {
		t.Fatalf("token missing in mail: %s", text)
	}
	rest := text[idx+len(marker):]
	if nl := strings.IndexAny(rest, "\r\n"); nl >= 0 {
		rest = rest[:nl]
	}
	return rest
}

func (c *client) confirmEmailChange(token string) response {
	c.t.Helper()
	return c.do(http.MethodPost, "/change-email", "token="+token, func(req *http.Request) {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	})
}

func TestEmailChangeRequiresPasswordAndSMTP(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "email-change-smtp@example.com", "correct horse battery")

	if resp := c.do(http.MethodPost, "/api/v1/auth/email-change",
		`{"password":"wrong-password","newEmail":"next@example.com"}`); resp.status != http.StatusForbidden {
		t.Fatalf("wrong password = %d %s", resp.status, resp.body)
	}
	if resp := c.do(http.MethodPost, "/api/v1/auth/email-change",
		`{"password":"correct horse battery","newEmail":"email-change-smtp@example.com"}`); resp.status != http.StatusUnprocessableEntity ||
		!strings.Contains(resp.body, "same_email") {
		t.Fatalf("same email = %d %s", resp.status, resp.body)
	}

	other := env.client(t)
	registerVerified(t, env, other, "taken@example.com", "correct horse battery")
	if resp := c.do(http.MethodPost, "/api/v1/auth/email-change",
		`{"password":"correct horse battery","newEmail":"taken@example.com"}`); resp.status != http.StatusConflict ||
		!strings.Contains(resp.body, "email_taken") {
		t.Fatalf("taken email = %d %s", resp.status, resp.body)
	}

	// 前三次已经用完 burst，第四次必须被限流。
	if resp := c.do(http.MethodPost, "/api/v1/auth/email-change",
		`{"password":"correct horse battery","newEmail":"next@example.com"}`); resp.status != http.StatusTooManyRequests {
		t.Fatalf("rate limit = %d %s", resp.status, resp.body)
	}
}

func TestEmailChangeUnavailableWithoutSMTP(t *testing.T) {
	env := newEnv(t, func(_ *config.Config, values *settings.Values) {
		values.SMTPHost = ""
		values.SMTPFrom = ""
	})
	c := env.client(t)
	// SMTP 不可用时验证要求自动关闭，注册会直接登录。
	if resp := c.register("no-smtp-change@example.com", "correct horse battery"); resp.status != http.StatusCreated {
		t.Fatalf("register = %d %s", resp.status, resp.body)
	}

	me := c.do(http.MethodGet, "/api/v1/auth/me", "")
	if !strings.Contains(me.body, `"emailChangeAvailable":false`) {
		t.Fatalf("me should report email change unavailable: %s", me.body)
	}
	resp := c.do(http.MethodPost, "/api/v1/auth/email-change",
		`{"password":"correct horse battery","newEmail":"next@example.com"}`)
	if resp.status != http.StatusServiceUnavailable || !strings.Contains(resp.body, "email_not_configured") {
		t.Fatalf("email change without SMTP = %d %s", resp.status, resp.body)
	}
}

func TestEmailChangeConfirmationKeepsCurrentSession(t *testing.T) {
	env := newEnv(t, nil)
	current := env.client(t)
	registerVerified(t, env, current, "old-address@example.com", "correct horse battery")

	other := env.client(t)
	if resp := other.login("old-address@example.com", "correct horse battery"); resp.status != http.StatusOK {
		t.Fatalf("other login = %d %s", resp.status, resp.body)
	}

	req := current.do(http.MethodPost, "/api/v1/auth/email-change",
		`{"password":"correct horse battery","newEmail":"new-address@example.com"}`)
	if req.status != http.StatusAccepted {
		t.Fatalf("request = %d %s", req.status, req.body)
	}
	if !strings.Contains(req.body, `"pendingEmail":"new-address@example.com"`) {
		t.Fatalf("pending email missing: %s", req.body)
	}
	if msg := env.mailer.last(); msg.To != "new-address@example.com" {
		t.Fatalf("confirmation must go to the new address, got %s", msg.To)
	}
	token := extractMailToken(t, env.mailer.last().Text, "/change-email?token=")

	// GET only renders; it must not consume the token.
	page := current.do(http.MethodGet, "/change-email?token="+token, "")
	if page.status != http.StatusOK || !strings.Contains(page.body, "确认新邮箱") {
		t.Fatalf("change email page = %d %s", page.status, page.body)
	}
	me := current.do(http.MethodGet, "/api/v1/auth/me", "")
	if !strings.Contains(me.body, `"email":"old-address@example.com"`) || !strings.Contains(me.body, `"pendingEmail":"new-address@example.com"`) {
		t.Fatalf("GET must not change the address: %s", me.body)
	}

	link := current.confirmEmailChange(token)
	if link.status != http.StatusSeeOther || !strings.Contains(link.header.Get("Location"), "email_changed=1") {
		t.Fatalf("confirm = %d %q", link.status, link.header.Get("Location"))
	}

	me = current.do(http.MethodGet, "/api/v1/auth/me", "")
	if !strings.Contains(me.body, `"email":"new-address@example.com"`) ||
		!strings.Contains(me.body, `"emailVerified":true`) ||
		strings.Contains(me.body, `"pendingEmail"`) {
		t.Fatalf("unexpected user after confirm: %s", me.body)
	}
	if resp := other.do(http.MethodGet, "/api/v1/auth/me", ""); resp.status != http.StatusUnauthorized {
		t.Fatalf("other session should be revoked: %d %s", resp.status, resp.body)
	}

	// 旧邮箱收到通知，审计可查。
	msg := env.mailer.last()
	if msg.To != "old-address@example.com" || !strings.Contains(msg.Subject, "邮箱已修改") {
		t.Fatalf("old address notice missing: %+v", msg)
	}
	entries, err := env.store.ListAudit(context.Background(), nil, 20)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	found := false
	for _, entry := range entries {
		if entry.Action == "account.email_change" {
			found = true
		}
	}
	if !found {
		t.Fatalf("email change was not audited: %+v", entries)
	}

	// 新邮箱可以登录，旧邮箱不能。
	if resp := env.client(t).login("new-address@example.com", "correct horse battery"); resp.status != http.StatusOK {
		t.Fatalf("login with new email = %d %s", resp.status, resp.body)
	}
	if resp := env.client(t).login("old-address@example.com", "correct horse battery"); resp.status != http.StatusUnauthorized {
		t.Fatalf("login with old email = %d %s", resp.status, resp.body)
	}
}

func TestEmailChangeOnLoggedOutDeviceRevokesAllSessions(t *testing.T) {
	env := newEnv(t, nil)
	owner := env.client(t)
	registerVerified(t, env, owner, "move-owner@example.com", "correct horse battery")

	if resp := owner.do(http.MethodPost, "/api/v1/auth/email-change",
		`{"password":"correct horse battery","newEmail":"move-new@example.com"}`); resp.status != http.StatusAccepted {
		t.Fatalf("request = %d %s", resp.status, resp.body)
	}
	token := extractMailToken(t, env.mailer.last().Text, "/change-email?token=")

	// 在一台没有该账号会话的设备上确认。
	stranger := env.client(t)
	confirmed := stranger.confirmEmailChange(token)
	if confirmed.status != http.StatusSeeOther || !strings.Contains(confirmed.header.Get("Location"), "login=1") {
		t.Fatalf("confirm without session = %d %q", confirmed.status, confirmed.header.Get("Location"))
	}
	if resp := owner.do(http.MethodGet, "/api/v1/auth/me", ""); resp.status != http.StatusUnauthorized {
		t.Fatalf("all sessions should be revoked: %d %s", resp.status, resp.body)
	}
	if resp := env.client(t).login("move-new@example.com", "correct horse battery"); resp.status != http.StatusOK {
		t.Fatalf("login after confirm = %d %s", resp.status, resp.body)
	}
}

func TestEmailChangeTokenExpiryReuseAndOverwrite(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "token-owner@example.com", "correct horse battery")

	request := func(email string) string {
		t.Helper()
		resp := c.do(http.MethodPost, "/api/v1/auth/email-change",
			fmt.Sprintf(`{"password":"correct horse battery","newEmail":%q}`, email))
		if resp.status != http.StatusAccepted {
			t.Fatalf("request %s = %d %s", email, resp.status, resp.body)
		}
		return extractMailToken(t, env.mailer.last().Text, "/change-email?token=")
	}

	// 覆盖 pending：旧 token 被删除，最新 token 生效。
	first := request("first-new@example.com")
	second := request("second-new@example.com")
	if reuse := c.confirmEmailChange(first); !strings.Contains(reuse.header.Get("Location"), "email_change=expired") {
		t.Fatalf("old token should be invalid, got %q", reuse.header.Get("Location"))
	}
	if ok := c.confirmEmailChange(second); !strings.Contains(ok.header.Get("Location"), "email_changed=1") {
		t.Fatalf("latest token should work, got %q", ok.header.Get("Location"))
	}
	// 重复使用已消费的 token。
	if reuse := c.confirmEmailChange(second); !strings.Contains(reuse.header.Get("Location"), "email_change=expired") {
		t.Fatalf("used token should be invalid, got %q", reuse.header.Get("Location"))
	}

	// 过期 token。
	expiring := request("expired-new@example.com")
	if _, err := env.store.Exec(t.Context(), `
		UPDATE email_tokens SET expires_at = now() - interval '1 hour'
		WHERE kind = 'change_email' AND used_at IS NULL`); err != nil {
		t.Fatalf("expire token: %v", err)
	}
	if expired := c.confirmEmailChange(expiring); !strings.Contains(expired.header.Get("Location"), "email_change=expired") {
		t.Fatalf("expired token should be invalid, got %q", expired.header.Get("Location"))
	}
}

func TestRefreshSessionsListAndLogoutAll(t *testing.T) {
	env := newEnv(t, nil)
	current := env.client(t)
	registerVerified(t, env, current, "sessions@example.com", "correct horse battery")

	if resp := current.do(http.MethodPost, "/api/v1/auth/refresh", ""); resp.status != http.StatusOK || !strings.Contains(resp.body, "expiresAt") {
		t.Fatalf("refresh = %d %s", resp.status, resp.body)
	}

	list := current.do(http.MethodGet, "/api/v1/auth/sessions", "")
	if list.status != http.StatusOK || !strings.Contains(list.body, `"current":true`) {
		t.Fatalf("sessions = %d %s", list.status, list.body)
	}

	other := env.client(t)
	if resp := other.login("sessions@example.com", "correct horse battery"); resp.status != http.StatusOK {
		t.Fatalf("second login = %d %s", resp.status, resp.body)
	}
	list = current.do(http.MethodGet, "/api/v1/auth/sessions", "")
	var sessions struct {
		Sessions []struct {
			ID      string `json:"id"`
			Current bool   `json:"current"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal([]byte(list.body), &sessions); err != nil {
		t.Fatalf("decode sessions: %v", err)
	}
	if len(sessions.Sessions) != 2 {
		t.Fatalf("expected two sessions, got %d", len(sessions.Sessions))
	}

	if resp := current.do(http.MethodPost, "/api/v1/auth/logout-all", ""); resp.status != http.StatusOK {
		t.Fatalf("logout-all = %d %s", resp.status, resp.body)
	}
	if resp := other.do(http.MethodGet, "/api/v1/auth/me", ""); resp.status != http.StatusUnauthorized {
		t.Fatalf("other session after logout-all = %d %s", resp.status, resp.body)
	}
	if resp := current.do(http.MethodGet, "/api/v1/auth/me", ""); resp.status != http.StatusOK {
		t.Fatalf("current session after logout-all = %d %s", resp.status, resp.body)
	}

	export := current.do(http.MethodGet, "/api/v1/account/export", "")
	if export.status != http.StatusOK || !strings.Contains(export.header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("export = %d %s", export.status, export.body)
	}
	var payload struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal([]byte(export.body), &payload); err != nil || payload.Version != 2 {
		t.Fatalf("export payload = %s (err %v)", export.body, err)
	}
}
