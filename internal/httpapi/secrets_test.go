package httpapi_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func testB64(n int) string {
	return base64.StdEncoding.EncodeToString(make([]byte, n))
}

func testDataKeyEnvelope(kind string) string {
	return `{"version":4,"kind":"` + kind + `","encrypted":true,"keySource":"data-key",` +
		`"cipher":"aes-256-gcm","data":"` + testB64(96) + `"}`
}

func testPrivacyEnvelope() string {
	return `{"version":4,"kind":"privacy","encrypted":true,"keySource":"password",` +
		`"cipher":"aes-256-gcm","kdf":"pbkdf2-sha256","iterations":600000,` +
		`"salt":"` + testB64(16) + `","wrappedKey":"` + testB64(60) + `","check":"` + testB64(28) + `",` +
		`"data":"` + testB64(96) + `","recovery":{"wrappedKey":"` + testB64(60) + `"}}`
}

type secretResponse struct {
	Revision  int64           `json:"revision"`
	Payload   json.RawMessage `json:"payload"`
	UpdatedAt *string         `json:"updatedAt"`
	Error     struct {
		Code string `json:"code"`
	} `json:"error"`
	Current struct {
		Revision int64           `json:"revision"`
		Payload  json.RawMessage `json:"payload"`
	} `json:"current"`
}

func jsonEqual(a, b []byte) bool {
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		return false
	}
	encodedLeft, _ := json.Marshal(left)
	encodedRight, _ := json.Marshal(right)
	return string(encodedLeft) == string(encodedRight)
}

func TestSecretsRequireAuth(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)

	if resp := c.do(http.MethodGet, "/api/v1/secrets/memo", ""); resp.status != http.StatusUnauthorized {
		t.Fatalf("anonymous get = %d %s", resp.status, resp.body)
	}
	if resp := c.do(http.MethodPut, "/api/v1/secrets/memo", `{"baseRevision":0,"payload":{}}`); resp.status != http.StatusUnauthorized {
		t.Fatalf("anonymous put = %d %s", resp.status, resp.body)
	}
}

func TestSecretsCRUDAndRevision(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "secret@example.com", "correct horse battery")

	// Empty secret starts at revision 0 with no payload.
	resp := c.do(http.MethodGet, "/api/v1/secrets/ai", "")
	if resp.status != http.StatusOK {
		t.Fatalf("get empty = %d %s", resp.status, resp.body)
	}
	var got secretResponse
	if err := json.Unmarshal([]byte(resp.body), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Revision != 0 || (len(got.Payload) != 0 && string(got.Payload) != "null") || got.UpdatedAt != nil {
		t.Fatalf("unexpected empty secret: %s", resp.body)
	}

	// Create.
	memo := testDataKeyEnvelope("memo")
	body := fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, memo)
	if created := c.do(http.MethodPut, "/api/v1/secrets/memo", body); created.status != http.StatusOK {
		t.Fatalf("create = %d %s", created.status, created.body)
	}

	resp = c.do(http.MethodGet, "/api/v1/secrets/memo", "")
	if err := json.Unmarshal([]byte(resp.body), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Revision != 1 || !jsonEqual(got.Payload, []byte(memo)) || got.UpdatedAt == nil {
		t.Fatalf("unexpected stored secret: %s", resp.body)
	}

	// Same base revision again conflicts and returns the current ciphertext.
	stale := c.do(http.MethodPut, "/api/v1/secrets/memo", body)
	if stale.status != http.StatusConflict {
		t.Fatalf("stale put = %d %s", stale.status, stale.body)
	}
	if err := json.Unmarshal([]byte(stale.body), &got); err != nil {
		t.Fatalf("decode conflict: %v", err)
	}
	if got.Error.Code != "revision_conflict" || got.Current.Revision != 1 || !jsonEqual(got.Current.Payload, []byte(memo)) {
		t.Fatalf("unexpected conflict body: %s", stale.body)
	}

	// Retrying with the current revision succeeds.
	retry := fmt.Sprintf(`{"baseRevision":1,"payload":%s}`, testDataKeyEnvelope("memo"))
	if ok := c.do(http.MethodPut, "/api/v1/secrets/memo", retry); ok.status != http.StatusOK {
		t.Fatalf("retry = %d %s", ok.status, ok.body)
	}

	// Kinds are isolated from each other.
	ai := c.do(http.MethodGet, "/api/v1/secrets/ai", "")
	if err := json.Unmarshal([]byte(ai.body), &got); err != nil {
		t.Fatalf("decode ai: %v", err)
	}
	if got.Revision != 0 {
		t.Fatalf("ai should be untouched: %s", ai.body)
	}

	// Privacy uses its own password envelope.
	if ok := c.do(http.MethodPut, "/api/v1/secrets/privacy", fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, testPrivacyEnvelope())); ok.status != http.StatusOK {
		t.Fatalf("privacy put = %d %s", ok.status, ok.body)
	}
}

func TestSecretsValidateKindAndSize(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "validate@example.com", "correct horse battery")

	cases := []struct {
		name   string
		path   string
		body   string
		status int
		code   string
	}{
		{
			name:   "kind swap",
			path:   "/api/v1/secrets/ai",
			body:   fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, testDataKeyEnvelope("memo")),
			status: http.StatusUnprocessableEntity,
			code:   "secret_kind_mismatch",
		},
		{
			name:   "privacy on memo",
			path:   "/api/v1/secrets/memo",
			body:   fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, testPrivacyEnvelope()),
			status: http.StatusUnprocessableEntity,
			code:   "secret_kind_mismatch",
		},
		{
			name:   "not an envelope",
			path:   "/api/v1/secrets/memo",
			body:   `{"baseRevision":0,"payload":{"version":2}}`,
			status: http.StatusUnprocessableEntity,
			code:   "unsupported_version",
		},
		{
			name:   "negative revision",
			path:   "/api/v1/secrets/memo",
			body:   fmt.Sprintf(`{"baseRevision":-1,"payload":%s}`, testDataKeyEnvelope("memo")),
			status: http.StatusUnprocessableEntity,
			code:   "invalid_payload",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := c.do(http.MethodPut, tc.path, tc.body)
			if resp.status != tc.status {
				t.Fatalf("status = %d, body = %s", resp.status, resp.body)
			}
			if !strings.Contains(resp.body, `"code":"`+tc.code+`"`) {
				t.Fatalf("expected code %s, got %s", tc.code, resp.body)
			}
		})
	}

	// Unknown kind behaves like a missing route.
	if resp := c.do(http.MethodGet, "/api/v1/secrets/files", ""); resp.status != http.StatusNotFound {
		t.Fatalf("unknown kind get = %d %s", resp.status, resp.body)
	}
	if resp := c.do(http.MethodPut, "/api/v1/secrets/files", `{}`); resp.status != http.StatusNotFound {
		t.Fatalf("unknown kind put = %d %s", resp.status, resp.body)
	}

	// AI envelopes are capped tighter than memo envelopes.
	big := `{"version":4,"kind":"ai","encrypted":true,"keySource":"data-key",` +
		`"cipher":"aes-256-gcm","data":"` + testB64(80*1024) + `"}`
	resp := c.do(http.MethodPut, "/api/v1/secrets/ai", fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, big))
	if resp.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized ai = %d %s", resp.status, resp.body)
	}
}

func TestSecretsIsolatedPerUser(t *testing.T) {
	env := newEnv(t, nil)
	alice := env.client(t)
	registerVerified(t, env, alice, "alice@example.com", "correct horse battery")
	if resp := alice.do(http.MethodPut, "/api/v1/secrets/memo",
		fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, testDataKeyEnvelope("memo"))); resp.status != http.StatusOK {
		t.Fatalf("alice put = %d %s", resp.status, resp.body)
	}

	bob := env.client(t)
	registerVerified(t, env, bob, "bob@example.com", "correct horse battery")
	resp := bob.do(http.MethodGet, "/api/v1/secrets/memo", "")
	if resp.status != http.StatusOK || !strings.Contains(resp.body, `"revision":0`) {
		t.Fatalf("bob must not see alice's secret: %d %s", resp.status, resp.body)
	}
}

func TestAdminCannotReadSecrets(t *testing.T) {
	env := newEnv(t, nil)

	user := env.client(t)
	registerVerified(t, env, user, "owner@example.com", "correct horse battery")
	marker := testDataKeyEnvelope("memo")
	if resp := user.do(http.MethodPut, "/api/v1/secrets/memo",
		fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, marker)); resp.status != http.StatusOK {
		t.Fatalf("owner put = %d %s", resp.status, resp.body)
	}

	admin := env.client(t)
	registerVerified(t, env, admin, "admin@example.com", "correct horse battery")
	env.makeAdmin(t, "admin@example.com")

	users := admin.do(http.MethodGet, "/api/v1/admin/users", "")
	if users.status != http.StatusOK {
		t.Fatalf("admin users = %d %s", users.status, users.body)
	}
	var list struct {
		Users []struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"users"`
	}
	if err := json.Unmarshal([]byte(users.body), &list); err != nil {
		t.Fatalf("decode users: %v", err)
	}
	var ownerID string
	for _, item := range list.Users {
		if item.Email == "owner@example.com" {
			ownerID = item.ID
		}
	}
	if ownerID == "" {
		t.Fatal("owner not found in admin user list")
	}

	// The existing admin workspace view must not expose secrets.
	workspace := admin.do(http.MethodGet, "/api/v1/admin/users/"+ownerID+"/workspace", "")
	if workspace.status != http.StatusOK {
		t.Fatalf("admin workspace = %d %s", workspace.status, workspace.body)
	}
	if strings.Contains(workspace.body, `"kind":"memo"`) || strings.Contains(workspace.body, `"aes-256-gcm"`) {
		t.Fatalf("workspace response leaked secret ciphertext: %s", workspace.body)
	}

	// There is deliberately no admin secret endpoint.
	for _, path := range []string{
		"/api/v1/admin/users/" + ownerID + "/secrets",
		"/api/v1/admin/users/" + ownerID + "/secrets/memo",
		"/api/v1/admin/secrets",
	} {
		if resp := admin.do(http.MethodGet, path, ""); resp.status != http.StatusNotFound {
			t.Fatalf("%s = %d, expected 404", path, resp.status)
		}
	}
}
