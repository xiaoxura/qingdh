package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func testV3Envelope() string {
	return fmt.Sprintf(`{"version":3,"encrypted":true,"kdf":"pbkdf2-sha256","iterations":600000,"salt":%q,"wrappedKey":%q,"check":%q,"data":%q,"recovery":{"wrappedKey":%q}}`,
		testB64(16), testB64(60), testB64(32), testB64(64), testB64(60))
}

const testPlainV2 = `{"version":2,"settings":{"name":"明文","engine":"bing"},"groups":[{"id":"g1","name":"常用","links":[{"id":"l1","title":"GitHub","url":"https://github.com/"}]}]}`

// enableTestEncryption turns the account document into a valid v3 envelope.
func enableTestEncryption(t *testing.T, c *client) {
	t.Helper()
	resp := c.do(http.MethodPut, "/api/v1/workspace",
		fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, testV3Envelope()))
	if resp.status != http.StatusOK {
		t.Fatalf("enable encryption = %d %s", resp.status, resp.body)
	}
}

func disableBody(baseRevision int, password string) string {
	return fmt.Sprintf(`{"baseRevision":%d,"currentPassword":%q,"payload":%s}`, baseRevision, password, testPlainV2)
}

func TestDisableEncryptionRequiresLoginAndEncryptedDocument(t *testing.T) {
	env := newEnv(t, nil)
	anonymous := env.client(t)
	if resp := anonymous.do(http.MethodPost, "/api/v1/workspace/disable-encryption",
		disableBody(0, "correct horse battery")); resp.status != http.StatusUnauthorized {
		t.Fatalf("anonymous disable = %d %s", resp.status, resp.body)
	}

	c := env.client(t)
	registerVerified(t, env, c, "plain-disable@example.com", "correct horse battery")
	resp := c.do(http.MethodPost, "/api/v1/workspace/disable-encryption",
		disableBody(0, "correct horse battery"))
	if resp.status != http.StatusUnprocessableEntity || !strings.Contains(resp.body, "not_encrypted") {
		t.Fatalf("plain document disable = %d %s", resp.status, resp.body)
	}
}

func TestDisableEncryptionChecksPasswordRevisionAndPayload(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "guarded-disable@example.com", "correct horse battery")
	enableTestEncryption(t, c)

	// 密码错误：403，文档保持 v3。
	wrong := c.do(http.MethodPost, "/api/v1/workspace/disable-encryption",
		disableBody(1, "wrong password"))
	if wrong.status != http.StatusForbidden || !strings.Contains(wrong.body, "invalid_password") {
		t.Fatalf("wrong password = %d %s", wrong.status, wrong.body)
	}

	// baseRevision 不匹配：409，文档保持 v3。
	stale := c.do(http.MethodPost, "/api/v1/workspace/disable-encryption",
		disableBody(0, "correct horse battery"))
	if stale.status != http.StatusConflict || !strings.Contains(stale.body, "revision_conflict") {
		t.Fatalf("stale revision = %d %s", stale.status, stale.body)
	}

	// 提交 v3 envelope 而不是明文 v2：422。
	encryptedPayload := fmt.Sprintf(`{"baseRevision":1,"currentPassword":"correct horse battery","payload":%s}`, testV3Envelope())
	badPayload := c.do(http.MethodPost, "/api/v1/workspace/disable-encryption", encryptedPayload)
	if badPayload.status != http.StatusUnprocessableEntity || !strings.Contains(badPayload.body, "invalid_payload") {
		t.Fatalf("encrypted payload = %d %s", badPayload.status, badPayload.body)
	}

	got := c.do(http.MethodGet, "/api/v1/workspace", "")
	var current struct {
		Revision int64 `json:"revision"`
		Payload  struct {
			Version int `json:"version"`
		} `json:"payload"`
	}
	if err := json.Unmarshal([]byte(got.body), &current); err != nil {
		t.Fatalf("decode workspace: %v", err)
	}
	if current.Revision != 1 || current.Payload.Version != 3 {
		t.Fatalf("failed attempts must not change the document: %+v", current)
	}

	// 原有的 PUT 降级防护不受新端点影响。
	downgrade := c.do(http.MethodPut, "/api/v1/workspace",
		fmt.Sprintf(`{"baseRevision":1,"payload":%s}`, testPlainV2))
	if downgrade.status != http.StatusUnprocessableEntity || !strings.Contains(downgrade.body, "encryption_required") {
		t.Fatalf("PUT downgrade must stay blocked: %d %s", downgrade.status, downgrade.body)
	}
}

func TestDisableEncryptionSucceedsAndIsAudited(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "success-disable@example.com", "correct horse battery")
	enableTestEncryption(t, c)

	resp := c.do(http.MethodPost, "/api/v1/workspace/disable-encryption",
		disableBody(1, "correct horse battery"))
	if resp.status != http.StatusOK {
		t.Fatalf("disable = %d %s", resp.status, resp.body)
	}
	var result struct {
		Revision int64 `json:"revision"`
	}
	if err := json.Unmarshal([]byte(resp.body), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if result.Revision != 2 {
		t.Fatalf("revision = %d, want 2", result.Revision)
	}

	got := c.do(http.MethodGet, "/api/v1/workspace", "")
	var stored struct {
		Revision int64           `json:"revision"`
		Payload  json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal([]byte(got.body), &stored); err != nil {
		t.Fatalf("decode stored workspace: %v", err)
	}
	if stored.Revision != 2 || !jsonEqual(stored.Payload, []byte(testPlainV2)) {
		t.Fatalf("stored workspace = %d %s", stored.Revision, stored.Payload)
	}

	entries, err := env.store.ListAudit(context.Background(), nil, 20)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	found := false
	for _, entry := range entries {
		if entry.Action == "account.encryption_disabled" {
			found = true
		}
	}
	if !found {
		t.Fatalf("disable encryption was not audited: %+v", entries)
	}

	// 明文文档现在可以继续正常 PUT。
	next := c.do(http.MethodPut, "/api/v1/workspace",
		fmt.Sprintf(`{"baseRevision":2,"payload":%s}`, testPlainV2))
	if next.status != http.StatusOK {
		t.Fatalf("plaintext PUT after disable = %d %s", next.status, next.body)
	}
}

func TestDisableEncryptionBlocksDataKeySecretsButKeepsPrivacy(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "dependency-disable@example.com", "correct horse battery")
	enableTestEncryption(t, c)

	for _, kind := range []string{"ai", "memo"} {
		if resp := c.do(http.MethodPut, "/api/v1/secrets/"+kind,
			fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, testDataKeyEnvelope(kind))); resp.status != http.StatusOK {
			t.Fatalf("put %s = %d %s", kind, resp.status, resp.body)
		}
	}

	blocked := c.do(http.MethodPost, "/api/v1/workspace/disable-encryption",
		disableBody(1, "correct horse battery"))
	if blocked.status != http.StatusConflict || !strings.Contains(blocked.body, "encryption_dependency") {
		t.Fatalf("dependency block = %d %s", blocked.status, blocked.body)
	}
	if !strings.Contains(blocked.body, `"ai"`) || !strings.Contains(blocked.body, `"memo"`) {
		t.Fatalf("dependency response should name the blocking kinds: %s", blocked.body)
	}

	// 文档仍是 v3。
	got := c.do(http.MethodGet, "/api/v1/workspace", "")
	if !strings.Contains(got.body, `"version":3`) {
		t.Fatalf("blocked disable must keep the document encrypted: %s", got.body)
	}

	// 用户导出/确认不再需要后，通过显式 DELETE 删除 AI / 备忘录密文；
	// 隐私空间使用独立密钥，允许保留。
	for _, kind := range []string{"ai", "memo"} {
		if resp := c.do(http.MethodDelete, "/api/v1/secrets/"+kind, ""); resp.status != http.StatusOK {
			t.Fatalf("delete %s = %d %s", kind, resp.status, resp.body)
		}
		// 幂等：重复删除仍然成功。
		if resp := c.do(http.MethodDelete, "/api/v1/secrets/"+kind, ""); resp.status != http.StatusOK {
			t.Fatalf("delete %s twice = %d %s", kind, resp.status, resp.body)
		}
	}
	for _, kind := range []string{"ai", "memo"} {
		if resp := c.do(http.MethodGet, "/api/v1/secrets/"+kind, ""); resp.status != http.StatusOK || !strings.Contains(resp.body, `"revision":0`) {
			t.Fatalf("secret %s should be gone: %d %s", kind, resp.status, resp.body)
		}
	}
	if resp := c.do(http.MethodPut, "/api/v1/secrets/privacy",
		fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, testPrivacyEnvelope())); resp.status != http.StatusOK {
		t.Fatalf("put privacy = %d %s", resp.status, resp.body)
	}

	ok := c.do(http.MethodPost, "/api/v1/workspace/disable-encryption",
		disableBody(1, "correct horse battery"))
	if ok.status != http.StatusOK {
		t.Fatalf("disable with privacy secret = %d %s", ok.status, ok.body)
	}
	user, err := env.store.UserByEmail(t.Context(), "dependency-disable@example.com")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	secret, err := env.store.GetSecret(t.Context(), user.ID, "privacy")
	if err != nil || secret.Revision != 1 {
		t.Fatalf("privacy secret should survive: %+v, %v", secret, err)
	}
}
