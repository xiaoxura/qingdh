package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/XiaoXuRa/qingdh/internal/auth"
	"github.com/XiaoXuRa/qingdh/internal/config"
	"github.com/XiaoXuRa/qingdh/internal/httpapi"
	"github.com/XiaoXuRa/qingdh/internal/settings"
)

func registerVerified(t *testing.T, env *testEnv, c *client, email, password string) {
	t.Helper()
	resp := c.register(email, password)
	if resp.status != http.StatusAccepted {
		t.Fatalf("register = %d %s", resp.status, resp.body)
	}
	link := c.verifyEmail(env.verifyToken(t))
	if link.status != http.StatusSeeOther {
		t.Fatalf("verify = %d %s", link.status, link.body)
	}
}

func TestAdminRequiresPermission(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "user@example.com", "correct horse battery")

	if resp := c.do(http.MethodGet, "/api/v1/admin/settings", ""); resp.status != http.StatusForbidden {
		t.Fatalf("non-admin settings = %d %s", resp.status, resp.body)
	}
	if resp := c.do(http.MethodGet, "/api/v1/admin/users", ""); resp.status != http.StatusForbidden {
		t.Fatalf("non-admin users = %d %s", resp.status, resp.body)
	}

	if resp := c.do(http.MethodGet, "/api/v1/auth/me", ""); resp.status != http.StatusOK {
		t.Fatalf("me = %d", resp.status)
	} else if !strings.Contains(resp.body, `"isAdmin":false`) {
		t.Fatalf("me should report non-admin: %s", resp.body)
	}
}

func TestAdminSettingsAndRegistrationSwitch(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "admin@example.com", "correct horse battery")
	env.makeAdmin(t, "admin@example.com")

	got := admin.do(http.MethodGet, "/api/v1/admin/settings", "")
	if got.status != http.StatusOK {
		t.Fatalf("get settings = %d %s", got.status, got.body)
	}
	if !strings.Contains(got.body, `"allowRegistration":true`) || !strings.Contains(got.body, `"smtpPasswordSet":false`) {
		t.Fatalf("unexpected settings payload: %s", got.body)
	}

	updated := admin.do(http.MethodPut, "/api/v1/admin/settings", `{
		"allowRegistration": false,
		"requireEmailVerification": false,
		"smtpPassword": "smtp-secret",
		"sessionIdleSeconds": 604800,
		"sessionAbsoluteSeconds": 2592000,
		"sessionRenewSeconds": 1800
	}`)
	if updated.status != http.StatusOK {
		t.Fatalf("put settings = %d %s", updated.status, updated.body)
	}
	if !strings.Contains(updated.body, `"smtpPasswordSet":true`) || !strings.Contains(updated.body, `"allowRegistration":false`) {
		t.Fatalf("settings not saved: %s", updated.body)
	}

	// Registration is disabled immediately, without a restart.
	stranger := env.client(t)
	if resp := stranger.register("late@example.com", "correct horse battery"); resp.status != http.StatusForbidden {
		t.Fatalf("registration should be closed, got %d %s", resp.status, resp.body)
	}

	// Session TTL changes apply to new sessions.
	if resp := admin.login("admin@example.com", "correct horse battery"); resp.status != http.StatusOK {
		t.Fatalf("login = %d %s", resp.status, resp.body)
	}
	me := admin.do(http.MethodGet, "/api/v1/auth/me", "")
	var payload struct {
		Session struct {
			ExpiresAt time.Time `json:"expiresAt"`
		} `json:"session"`
	}
	if err := json.Unmarshal([]byte(me.body), &payload); err != nil {
		t.Fatalf("decode me: %v", err)
	}
	remaining := time.Until(payload.Session.ExpiresAt)
	if remaining > 8*24*time.Hour || remaining < 6*24*time.Hour {
		t.Fatalf("new session expiry = %s, want roughly 7 days", remaining)
	}
}

func TestAdminBaseURLIsUsedInEmails(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "base@example.com", "correct horse battery")
	env.makeAdmin(t, "base@example.com")

	resp := admin.do(http.MethodPut, "/api/v1/admin/settings", `{"baseUrl":"https://nav.example.com/"}`)
	if resp.status != http.StatusOK {
		t.Fatalf("put base url = %d %s", resp.status, resp.body)
	}
	if !strings.Contains(resp.body, `"baseUrl":"https://nav.example.com"`) {
		t.Fatalf("base url not normalized: %s", resp.body)
	}

	c := env.client(t)
	if r := c.register("link@example.com", "correct horse battery"); r.status != http.StatusAccepted {
		t.Fatalf("register = %d %s", r.status, r.body)
	}
	if msg := env.mailer.last().Text; !strings.Contains(msg, "https://nav.example.com/verify-email?token=") {
		t.Fatalf("mail link does not use base url: %s", msg)
	}
}

func TestEmailSendingRequiresTrustedSiteURL(t *testing.T) {
	// 没有站点地址也没有 trusted_hosts 时，邮件链接会被请求 Host 污染，
	// 因此必须拒绝发信，而不是回退到 r.Host。
	env := newEnv(t, func(_ *config.Config, values *settings.Values) { values.BaseURL = "" })
	c := env.client(t)

	resp := c.register("origin@example.com", "correct horse battery")
	if resp.status != http.StatusServiceUnavailable || !strings.Contains(resp.body, "email_not_configured") {
		t.Fatalf("register without trusted origin = %d %s", resp.status, resp.body)
	}
	if len(env.mailer.messages) != 0 {
		t.Fatalf("no email may be sent without a trusted origin, got %d", len(env.mailer.messages))
	}
	if _, err := env.store.UserByEmail(t.Context(), "origin@example.com"); err == nil {
		t.Fatal("the account should not be created when its verification link cannot be sent")
	}

	// 找回密码保持恒定 202，但不会发出任何邮件。
	if forgot := c.do(http.MethodPost, "/api/v1/auth/forgot-password", `{"email":"origin@example.com"}`); forgot.status != http.StatusAccepted {
		t.Fatalf("forgot = %d %s", forgot.status, forgot.body)
	}
	if len(env.mailer.messages) != 0 {
		t.Fatalf("no reset email may be sent without a trusted origin, got %d", len(env.mailer.messages))
	}
}

func TestSecureCookieBehindTrustedProxy(t *testing.T) {
	env := newEnv(t, func(c *config.Config, v *settings.Values) {
		c.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
		v.RequireEmailVerification = false
	})
	c := env.client(t)
	origin := "https://" + strings.TrimPrefix(env.server.URL, "http://")

	resp := c.do(http.MethodPost, "/api/v1/auth/register",
		`{"email":"secure@example.com","password":"correct horse battery"}`,
		func(r *http.Request) {
			r.Header.Set("X-Forwarded-Proto", "https")
			r.Header.Set("Origin", origin)
		})
	if resp.status != http.StatusCreated {
		t.Fatalf("register = %d %s", resp.status, resp.body)
	}
	cookies := strings.Join(resp.header.Values("Set-Cookie"), "\n")
	if !strings.Contains(cookies, "__Host-qingdh_session=") || !strings.Contains(cookies, "Secure") {
		t.Fatalf("expected a secure __Host- cookie, got %q", cookies)
	}
	if !strings.Contains(cookies, auth.DeviceCookieName+"=") {
		t.Fatalf("expected a device cookie, got %q", cookies)
	}
}

func TestBaseURLHTTPSMarksCookiesSecureWithoutProxy(t *testing.T) {
	env := newEnv(t, func(_ *config.Config, v *settings.Values) {
		v.BaseURL = "https://nav.example.com"
		v.RequireEmailVerification = false
	})
	c := env.client(t)
	resp := c.do(http.MethodPost, "/api/v1/auth/register",
		`{"email":"canonical@example.com","password":"correct horse battery"}`)
	if resp.status != http.StatusCreated {
		t.Fatalf("register = %d %s", resp.status, resp.body)
	}
	cookies := strings.Join(resp.header.Values("Set-Cookie"), "\n")
	if !strings.Contains(cookies, "__Host-qingdh_session=") || !strings.Contains(cookies, "Secure") {
		t.Fatalf("expected secure __Host- cookie from configured base URL, got %q", cookies)
	}
	if hsts := resp.header.Get("Strict-Transport-Security"); hsts == "" {
		t.Fatal("expected HSTS on an HTTPS deployment")
	}
}

func TestAdminSettingsVersionConflictAndAudit(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "settings-lock@example.com", "correct horse battery")
	env.makeAdmin(t, "settings-lock@example.com")

	var current struct {
		Version int64 `json:"version"`
	}
	resp := admin.do(http.MethodGet, "/api/v1/admin/settings", "")
	if resp.status != http.StatusOK {
		t.Fatalf("get settings = %d %s", resp.status, resp.body)
	}
	if err := json.Unmarshal([]byte(resp.body), &current); err != nil {
		t.Fatalf("decode settings: %v", err)
	}

	first := admin.do(http.MethodPut, "/api/v1/admin/settings",
		fmt.Sprintf(`{"aiDailyLimit":201,"version":%d}`, current.Version))
	if first.status != http.StatusOK {
		t.Fatalf("first save = %d %s", first.status, first.body)
	}
	stale := admin.do(http.MethodPut, "/api/v1/admin/settings",
		fmt.Sprintf(`{"aiDailyLimit":202,"version":%d}`, current.Version))
	if stale.status != http.StatusConflict {
		t.Fatalf("stale save = %d %s", stale.status, stale.body)
	}

	entries, err := env.store.ListAudit(t.Context(), nil, 10)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	found := false
	for _, entry := range entries {
		if entry.Action == "admin.settings.update" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("settings update was not audited: %+v", entries)
	}
}

func TestAdminSettingsValidation(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "admin2@example.com", "correct horse battery")
	env.makeAdmin(t, "admin2@example.com")

	resp := admin.do(http.MethodPut, "/api/v1/admin/settings", `{"smtpPort": 70000, "smtpHost":"smtp.example.com","smtpFrom":"a@b.com"}`)
	if resp.status != http.StatusUnprocessableEntity {
		t.Fatalf("invalid settings = %d %s", resp.status, resp.body)
	}
}

func TestAdminTestEmail(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "mailer@example.com", "correct horse battery")
	env.makeAdmin(t, "mailer@example.com")

	before := len(env.mailer.messages)
	resp := admin.do(http.MethodPost, "/api/v1/admin/settings/test-email", `{"to":"inbox@example.com"}`)
	if resp.status != http.StatusOK {
		t.Fatalf("test email = %d %s", resp.status, resp.body)
	}
	if len(env.mailer.messages) != before+1 {
		t.Fatalf("expected one message, got %d", len(env.mailer.messages)-before)
	}
	if env.mailer.last().To != "inbox@example.com" {
		t.Fatalf("unexpected recipient: %s", env.mailer.last().To)
	}
}

func TestAdminUsersListAndDisable(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "boss@example.com", "correct horse battery")
	env.makeAdmin(t, "boss@example.com")

	other := env.client(t)
	registerVerified(t, env, other, "other@example.com", "correct horse battery")

	list := admin.do(http.MethodGet, "/api/v1/admin/users?q=other", "")
	if list.status != http.StatusOK {
		t.Fatalf("list = %d %s", list.status, list.body)
	}
	if !strings.Contains(list.body, `"total":1`) || !strings.Contains(list.body, "other@example.com") {
		t.Fatalf("unexpected list: %s", list.body)
	}

	var page struct {
		Users []struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"users"`
	}
	if err := json.Unmarshal([]byte(list.body), &page); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	otherID := page.Users[0].ID

	patch := admin.do(http.MethodPatch, "/api/v1/admin/users/"+otherID, `{"disabled":true}`)
	if patch.status != http.StatusOK {
		t.Fatalf("disable = %d %s", patch.status, patch.body)
	}

	// The admin action revokes existing sessions, so the cookie is no longer valid.
	if resp := other.do(http.MethodGet, "/api/v1/auth/me", ""); resp.status != http.StatusUnauthorized {
		t.Fatalf("disabled me = %d %s", resp.status, resp.body)
	}
	// And new logins are refused.
	if resp := other.login("other@example.com", "correct horse battery"); resp.status != http.StatusForbidden {
		t.Fatalf("disabled login = %d %s", resp.status, resp.body)
	}

	// Re-enable and log in again.
	admin.do(http.MethodPatch, "/api/v1/admin/users/"+otherID, `{"disabled":false}`)
	if resp := other.login("other@example.com", "correct horse battery"); resp.status != http.StatusOK {
		t.Fatalf("login after enable = %d %s", resp.status, resp.body)
	}
}

func TestAdminSelfProtection(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "self@example.com", "correct horse battery")
	env.makeAdmin(t, "self@example.com")

	me := admin.do(http.MethodGet, "/api/v1/auth/me", "")
	var payload struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.Unmarshal([]byte(me.body), &payload); err != nil {
		t.Fatalf("decode me: %v", err)
	}

	for _, body := range []string{`{"isAdmin":false}`, `{"disabled":true}`} {
		resp := admin.do(http.MethodPatch, "/api/v1/admin/users/"+payload.User.ID, body)
		if resp.status != http.StatusUnprocessableEntity || !strings.Contains(resp.body, "self_protection") {
			t.Fatalf("self protection failed: %d %s", resp.status, resp.body)
		}
	}
	if resp := admin.do(http.MethodDelete, "/api/v1/admin/users/"+payload.User.ID, ""); resp.status != http.StatusUnprocessableEntity {
		t.Fatalf("self delete = %d %s", resp.status, resp.body)
	}
}

func TestAdminCanInspectUserWorkspace(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "inspect@example.com", "correct horse battery")
	env.makeAdmin(t, "inspect@example.com")

	other := env.client(t)
	registerVerified(t, env, other, "data@example.com", "correct horse battery")

	payload := `{"version":2,"settings":{"name":"数据用户","engine":"bing"},"groups":[
		{"id":"g1","name":"开发","links":[
			{"id":"l1","title":"GitHub","url":"https://github.com/"},
			{"id":"l2","title":"MDN","url":"https://developer.mozilla.org/"}
		]},
		{"id":"g2","name":"工具","links":[{"id":"l3","title":"TinyPNG","url":"https://tinypng.com/"}]}
	]}`
	if put := other.do(http.MethodPut, "/api/v1/workspace", fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, payload)); put.status != http.StatusOK {
		t.Fatalf("put workspace = %d %s", put.status, put.body)
	}

	user, err := env.store.UserByEmail(t.Context(), "data@example.com")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}

	resp := admin.do(http.MethodGet, "/api/v1/admin/users/"+user.ID.String()+"/workspace", "")
	if resp.status != http.StatusOK {
		t.Fatalf("admin workspace = %d %s", resp.status, resp.body)
	}

	var data struct {
		User struct {
			Email string `json:"email"`
		} `json:"user"`
		Revision int64 `json:"revision"`
		Payload  struct {
			Groups []struct {
				Name  string `json:"name"`
				Links []struct {
					Title string `json:"title"`
					URL   string `json:"url"`
				} `json:"links"`
			} `json:"groups"`
		} `json:"payload"`
	}
	if err := json.Unmarshal([]byte(resp.body), &data); err != nil {
		t.Fatalf("decode workspace: %v", err)
	}
	if data.User.Email != "data@example.com" || data.Revision != 1 {
		t.Fatalf("unexpected workspace: %+v", data)
	}
	if len(data.Payload.Groups) != 2 || data.Payload.Groups[0].Name != "开发" {
		t.Fatalf("unexpected groups: %+v", data.Payload.Groups)
	}
	if len(data.Payload.Groups[0].Links) != 2 || data.Payload.Groups[0].Links[0].Title != "GitHub" {
		t.Fatalf("unexpected links: %+v", data.Payload.Groups[0].Links)
	}

	// A normal user cannot inspect anyone.
	if resp := other.do(http.MethodGet, "/api/v1/admin/users/"+user.ID.String()+"/workspace", ""); resp.status != http.StatusForbidden {
		t.Fatalf("non-admin workspace = %d %s", resp.status, resp.body)
	}
	// Unknown users are 404.
	if resp := admin.do(http.MethodGet, "/api/v1/admin/users/00000000-0000-0000-0000-000000000000/workspace", ""); resp.status != http.StatusNotFound {
		t.Fatalf("missing workspace = %d %s", resp.status, resp.body)
	}
}

func TestAdminCannotDeleteMissingUser(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "admin3@example.com", "correct horse battery")
	env.makeAdmin(t, "admin3@example.com")

	resp := admin.do(http.MethodDelete, "/api/v1/admin/users/00000000-0000-0000-0000-000000000000", "")
	if resp.status != http.StatusNotFound {
		t.Fatalf("delete missing = %d %s", resp.status, resp.body)
	}
}

func TestVerificationToggleTakesEffectImmediately(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "toggle@example.com", "correct horse battery")
	env.makeAdmin(t, "toggle@example.com")

	resp := admin.do(http.MethodPut, "/api/v1/admin/settings", `{"requireEmailVerification": false}`)
	if resp.status != http.StatusOK {
		t.Fatalf("put settings = %d %s", resp.status, resp.body)
	}

	c := env.client(t)
	created := c.register("instant@example.com", "correct horse battery")
	if created.status != http.StatusCreated {
		t.Fatalf("register without verification = %d %s", created.status, created.body)
	}
	if !strings.Contains(created.body, `"emailVerified":true`) {
		t.Fatalf("email should be marked verified: %s", created.body)
	}
}

func TestVerificationClosedWithoutSMTP(t *testing.T) {
	env := newEnv(t, func(_ *config.Config, v *settings.Values) {
		v.SMTPHost = ""
		v.SMTPFrom = ""
		v.RequireEmailVerification = true
	})
	c := env.client(t)

	resp := c.register("nosmtp@example.com", "correct horse battery")
	if resp.status != http.StatusCreated {
		t.Fatalf("register = %d %s", resp.status, resp.body)
	}
	if len(env.mailer.messages) != 0 {
		t.Fatalf("no email should be sent, got %d", len(env.mailer.messages))
	}
}

func TestAdminPageIsServed(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	resp := c.do(http.MethodGet, "/admin", "")
	if resp.status != http.StatusOK || !strings.Contains(resp.body, "<title>admin</title>") {
		t.Fatalf("admin route = %d %s", resp.status, resp.body)
	}
}

func TestDisabledUserCannotRenew(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "kick@example.com", "correct horse battery")
	env.makeAdmin(t, "kick@example.com")

	victim := env.client(t)
	registerVerified(t, env, victim, "victim@example.com", "correct horse battery")

	user, err := env.store.UserByEmail(t.Context(), "victim@example.com")
	if err != nil {
		t.Fatalf("load victim: %v", err)
	}
	if err := env.store.SetUserDisabled(t.Context(), user.ID, true); err != nil {
		t.Fatalf("disable: %v", err)
	}

	resp := victim.do(http.MethodGet, "/api/v1/auth/me", "")
	if resp.status != http.StatusForbidden || !strings.Contains(resp.body, "account_disabled") {
		t.Fatalf("disabled session = %d %s", resp.status, resp.body)
	}
	// The session row is removed as well.
	if _, err := env.store.LatestSessionForEmail(t.Context(), "victim@example.com"); err == nil {
		t.Fatal("session should be deleted")
	}
}

func TestAdminOverview(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "overview-admin@example.com", "correct horse battery")
	env.makeAdmin(t, "overview-admin@example.com")

	user := env.client(t)
	registerVerified(t, env, user, "overview-user@example.com", "correct horse battery")

	resp := admin.do(http.MethodGet, "/api/v1/admin/overview", "")
	if resp.status != http.StatusOK {
		t.Fatalf("overview = %d %s", resp.status, resp.body)
	}
	var overview struct {
		UsersTotal     int64 `json:"usersTotal"`
		UsersVerified  int64 `json:"usersVerified"`
		UsersAdmins    int64 `json:"usersAdmins"`
		SessionsActive int64 `json:"sessionsActive"`
		DocumentsTotal int64 `json:"documentsTotal"`
		SecretsPrivacy int64 `json:"secretsPrivacy"`
	}
	if err := json.Unmarshal([]byte(resp.body), &overview); err != nil {
		t.Fatalf("decode overview: %v (%s)", err, resp.body)
	}
	if overview.UsersTotal < 2 || overview.UsersVerified < 2 || overview.UsersAdmins < 1 {
		t.Fatalf("unexpected user counts: %+v", overview)
	}
	if overview.SessionsActive < 2 {
		t.Fatalf("active sessions = %d, want at least 2", overview.SessionsActive)
	}

	if denied := user.do(http.MethodGet, "/api/v1/admin/overview", ""); denied.status != http.StatusForbidden {
		t.Fatalf("non-admin overview = %d %s", denied.status, denied.body)
	}
}

func TestAdminReportsBuildVersion(t *testing.T) {
	env := newEnvOpts(t, nil, httpapi.WithVersion("v0.1.0"))
	admin := env.client(t)
	registerVerified(t, env, admin, "version-admin@example.com", "correct horse battery")
	env.makeAdmin(t, "version-admin@example.com")

	resp := admin.do(http.MethodGet, "/api/v1/admin/settings", "")
	if resp.status != http.StatusOK {
		t.Fatalf("settings = %d %s", resp.status, resp.body)
	}
	if !strings.Contains(resp.body, `"serverVersion":"v0.1.0"`) {
		t.Fatalf("build version missing from admin settings: %s", resp.body)
	}
}
