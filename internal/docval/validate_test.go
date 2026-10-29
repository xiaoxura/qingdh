package docval

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

func TestValidateCustomEngineIdentifier(t *testing.T) {
	for _, tc := range []struct {
		id    string
		valid bool
	}{
		{"c-12345678-1234-1234-1234-123456789012", true},
		{strings.Repeat("a", 50), true},
		{strings.Repeat("a", 51), false},
	} {
		t.Run(fmt.Sprint(len(tc.id)), func(t *testing.T) {
			payload := []byte(fmt.Sprintf(`{"version":2,"settings":{"name":"","engine":%q},"groups":[]}`, tc.id))
			_, err := Validate(payload, 64<<10)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%t, error=%v", tc.valid, err)
			}
		})
	}
}

func TestValidateAcceptsRealPayload(t *testing.T) {
	payload := []byte(`{
		"version": 2,
		"settings": {"name": "小夏", "engine": "bing"},
		"groups": [
			{"id": "g1", "name": "常用", "links": [
				{"id": "l1", "title": "GitHub", "url": "https://github.com/"},
				{"id": "l2", "title": "旧链接", "url": "", "deletedAt": 1760000000000}
			]},
			{"id": "g2", "name": "已删除", "deletedAt": 1760000000000, "links": []}
		]
	}`)

	out, err := Validate(payload, 64<<10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(out) != string(payload) {
		t.Fatal("validated payload should be returned unchanged")
	}
}

func TestValidateRejects(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		code   string
		expect string
	}{
		{"empty", ``, "invalid_payload", "空"},
		{"not json", `{`, "invalid_payload", "JSON"},
		{"array root", `[]`, "invalid_payload", "对象"},
		{"missing version", `{"groups":[]}`, "unsupported_version", "version"},
		{"old version", `{"version":1,"groups":[]}`, "unsupported_version", "version"},
		{"missing groups", `{"version":2}`, "invalid_payload", "groups"},
		{"groups not array", `{"version":2,"groups":{}}`, "invalid_payload", "数组"},
		{
			"javascript url",
			`{"version":2,"groups":[{"id":"g","name":"g","links":[{"id":"l","url":"javascript:alert(1)"}]}]}`,
			"invalid_url", "http",
		},
		{
			"relative url",
			`{"version":2,"groups":[{"id":"g","name":"g","links":[{"id":"l","url":"/admin"}]}]}`,
			"invalid_url", "http",
		},
		{
			"duplicate group id",
			`{"version":2,"groups":[{"id":"g","name":"a","links":[]},{"id":"g","name":"b","links":[]}]}`,
			"duplicate_id", "重复",
		},
		{
			"duplicate link id",
			`{"version":2,"groups":[{"id":"g","name":"a","links":[{"id":"l","url":"https://a.com"},{"id":"l","url":"https://b.com"}]}]}`,
			"duplicate_id", "重复",
		},
		{
			"long title",
			`{"version":2,"groups":[{"id":"g","name":"a","links":[{"id":"l","url":"https://a.com","title":"` + strings.Repeat("长", 41) + `"}]}]}`,
			"invalid_payload", "标题",
		},
		{
			"missing link id",
			`{"version":2,"groups":[{"id":"g","name":"a","links":[{"url":"https://a.com"}]}]}`,
			"invalid_payload", "id",
		},
		{
			"missing group name",
			`{"version":2,"groups":[{"id":"g","links":[]}]}`,
			"invalid_payload", "名称",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Validate([]byte(tc.body), 64<<10)
			if err == nil {
				t.Fatal("expected an error")
			}
			verr, ok := err.(*Error)
			if !ok {
				t.Fatalf("error type %T", err)
			}
			if verr.Code != tc.code {
				t.Fatalf("code = %q, want %q (%s)", verr.Code, tc.code, verr.Message)
			}
			if !strings.Contains(verr.Message, tc.expect) {
				t.Fatalf("message = %q, want it to contain %q", verr.Message, tc.expect)
			}
		})
	}
}

func TestValidateLimits(t *testing.T) {
	tooMany := strings.Repeat(`{"id":"x","name":"n","links":[]},`, MaxGroups+1)
	body := `{"version":2,"groups":[` + strings.TrimSuffix(tooMany, ",") + `]}`
	_, err := Validate([]byte(body), 1<<20)
	if err == nil {
		t.Fatal("expected group limit error")
	}
	if err.(*Error).Code != "too_many_groups" {
		t.Fatalf("code = %s", err.(*Error).Code)
	}

	big := `{"version":2,"groups":[],"padding":"` + strings.Repeat("a", 2048) + `"}`
	_, err = Validate([]byte(big), 100)
	if err == nil || err.(*Error).Code != "payload_too_large" {
		t.Fatalf("expected payload_too_large, got %v", err)
	}
}

func encryptedPayload(salt, wrapped, check, data, recovery string) []byte {
	return []byte(`{"version":3,"encrypted":true,"kdf":"pbkdf2-sha256","iterations":600000,` +
		`"salt":"` + salt + `","wrappedKey":"` + wrapped + `","check":"` + check + `",` +
		`"data":"` + data + `","recovery":{"wrappedKey":"` + recovery + `"}}`)
}

func TestValidateEncryptedEnvelope(t *testing.T) {
	b64 := func(n int) string {
		return base64.StdEncoding.EncodeToString(make([]byte, n))
	}
	salt, wrapped, check, data, recovery := b64(16), b64(60), b64(32), b64(64), b64(60)
	valid := encryptedPayload(salt, wrapped, check, data, recovery)
	if _, err := Validate(valid, 512*1024); err != nil {
		t.Fatalf("valid envelope rejected: %v", err)
	}

	cases := map[string][]byte{
		"not encrypted":    []byte(`{"version":3,"encrypted":false,"kdf":"pbkdf2-sha256","iterations":600000,"salt":"` + salt + `","wrappedKey":"` + wrapped + `","check":"` + check + `","data":"` + data + `","recovery":{"wrappedKey":"` + recovery + `"}}`),
		"bad kdf":          encryptedPayload(salt, wrapped, check, data, recovery)[:0],
		"missing recovery": []byte(`{"version":3,"encrypted":true,"kdf":"pbkdf2-sha256","iterations":600000,"salt":"` + salt + `","wrappedKey":"` + wrapped + `","check":"` + check + `","data":"` + data + `"}`),
		"bad base64":       []byte(`{"version":3,"encrypted":true,"kdf":"pbkdf2-sha256","iterations":600000,"salt":"!!!","wrappedKey":"` + wrapped + `","check":"` + check + `","data":"` + data + `","recovery":{"wrappedKey":"` + recovery + `"}}`),
		"short data":       encryptedPayload(salt, wrapped, check, b64(4), recovery),
	}
	cases["bad kdf"] = []byte(`{"version":3,"encrypted":true,"kdf":"argon2id","iterations":600000,"salt":"` + salt + `","wrappedKey":"` + wrapped + `","check":"` + check + `","data":"` + data + `","recovery":{"wrappedKey":"` + recovery + `"}}`)
	for name, payload := range cases {
		if _, err := Validate(payload, 512*1024); err == nil {
			t.Fatalf("%s should be rejected", name)
		}
	}
}
