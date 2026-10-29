package docval

import (
	"encoding/base64"
	"strings"
	"testing"
)

func b64(n int) string {
	return base64.StdEncoding.EncodeToString(make([]byte, n))
}

func dataKeyEnvelope(kind string) string {
	return `{"version":4,"kind":"` + kind + `","encrypted":true,"keySource":"data-key",` +
		`"cipher":"aes-256-gcm","data":"` + b64(96) + `"}`
}

func passwordEnvelope(kind string) string {
	return `{"version":4,"kind":"` + kind + `","encrypted":true,"keySource":"password",` +
		`"cipher":"aes-256-gcm","kdf":"pbkdf2-sha256","iterations":600000,` +
		`"salt":"` + b64(16) + `","wrappedKey":"` + b64(60) + `","check":"` + b64(28) + `",` +
		`"data":"` + b64(96) + `","recovery":{"wrappedKey":"` + b64(60) + `"}}`
}

func TestValidateSecretAccepts(t *testing.T) {
	cases := []struct {
		kind string
		body string
	}{
		{"ai", dataKeyEnvelope("ai")},
		{"memo", dataKeyEnvelope("memo")},
		{"privacy", passwordEnvelope("privacy")},
	}
	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			out, err := ValidateSecret(tc.kind, []byte(tc.body), MaxSecretBytesForKind(tc.kind))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if string(out) != tc.body {
				t.Fatal("valid envelope should be returned unchanged")
			}
		})
	}
}

func TestValidateSecretRejects(t *testing.T) {
	cases := []struct {
		name   string
		kind   string
		body   string
		code   string
		expect string
	}{
		{"unknown kind", "files", dataKeyEnvelope("memo"), "invalid_kind", "secret"},
		{"kind swap", "ai", dataKeyEnvelope("memo"), "secret_kind_mismatch", "用途"},
		{"privacy on memo", "memo", passwordEnvelope("privacy"), "secret_kind_mismatch", "用途"},
		{"data-key with password fields", "memo",
			`{"version":4,"kind":"memo","encrypted":true,"keySource":"data-key","cipher":"aes-256-gcm","salt":"` + b64(16) + `","data":"` + b64(96) + `"}`,
			"invalid_payload", "密码派生"},
		{"privacy missing recovery", "privacy",
			`{"version":4,"kind":"privacy","encrypted":true,"keySource":"password","cipher":"aes-256-gcm","kdf":"pbkdf2-sha256","iterations":600000,"salt":"` + b64(16) + `","wrappedKey":"` + b64(60) + `","check":"` + b64(28) + `","data":"` + b64(96) + `"}`,
			"invalid_payload", "recovery"},
		{"v3 envelope", "memo", `{"version":3,"encrypted":true,"data":"` + b64(96) + `"}`, "unsupported_version", "版本"},
		{"bad cipher", "memo",
			`{"version":4,"kind":"memo","encrypted":true,"keySource":"data-key","cipher":"aes-128-gcm","data":"` + b64(96) + `"}`,
			"invalid_payload", "算法"},
		{"bad base64", "memo",
			`{"version":4,"kind":"memo","encrypted":true,"keySource":"data-key","cipher":"aes-256-gcm","data":"###"}`,
			"invalid_payload", "Base64"},
		{"short data", "memo",
			`{"version":4,"kind":"memo","encrypted":true,"keySource":"data-key","cipher":"aes-256-gcm","data":"` + b64(8) + `"}`,
			"invalid_payload", "长度"},
		{"not an object", "memo", `[]`, "invalid_payload", "JSON"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateSecret(tc.kind, []byte(tc.body), MaxSecretBytesForKind(tc.kind))
			if err == nil {
				t.Fatal("expected an error")
			}
			verr, ok := err.(*Error)
			if !ok {
				t.Fatalf("unexpected error type: %T", err)
			}
			if verr.Code != tc.code {
				t.Fatalf("code = %s, want %s (%s)", verr.Code, tc.code, verr.Message)
			}
			if !strings.Contains(verr.Message, tc.expect) {
				t.Fatalf("message %q does not contain %q", verr.Message, tc.expect)
			}
		})
	}
}

func TestValidateSecretSizeLimits(t *testing.T) {
	big := dataKeyEnvelope("memo")
	if _, err := ValidateSecret("memo", []byte(big), 16); err == nil {
		t.Fatal("expected a size error")
	} else if verr := err.(*Error); verr.Code != "payload_too_large" {
		t.Fatalf("code = %s, want payload_too_large", verr.Code)
	}

	// AI config is capped much lower than memo/privacy envelopes.
	if MaxSecretBytesForKind("ai") >= MaxSecretBytesForKind("memo") {
		t.Fatal("AI config should have a tighter envelope limit")
	}
}
