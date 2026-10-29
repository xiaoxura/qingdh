package docval

import (
	"encoding/base64"
	"encoding/json"
)

// v4 secret envelopes carry AI configuration, memo documents and the privacy
// workspace. The server verifies the outer shape only: it never sees plaintext
// AI keys, memo bodies or privacy content.
const (
	// SecretVersion is the encrypted secret envelope version.
	SecretVersion = 4

	// MaxSecretBytes bounds every secret envelope.
	MaxSecretBytes = 512 * 1024

	// MaxAIConfigBytes bounds AI configuration envelopes. The plaintext config
	// is limited to 32 KiB client side, so 64 KiB of ciphertext is plenty.
	MaxAIConfigBytes = 64 * 1024

	secretCipher = "aes-256-gcm"
)

// secretKinds maps an allowed kind to the key source it must use. AI and memo
// data are derived from the main data key via HKDF; the privacy workspace uses
// its own password-derived key.
var secretKinds = map[string]string{
	"ai":      "data-key",
	"memo":    "data-key",
	"privacy": "password",
}

// SecretKindAllowed reports whether kind is part of the fixed allowlist.
func SecretKindAllowed(kind string) bool {
	_, ok := secretKinds[kind]
	return ok
}

// MaxSecretBytesForKind returns the per-kind envelope limit.
func MaxSecretBytesForKind(kind string) int {
	if kind == "ai" {
		return MaxAIConfigBytes
	}
	return MaxSecretBytes
}

// ValidateSecret checks a v4 secret envelope for the given kind. It rejects
// ciphertext swapping between kinds, field/key-source mismatches and malformed
// Base64. The payload is returned unchanged when valid.
func ValidateSecret(kind string, payload []byte, maxBytes int) ([]byte, error) {
	keySource, ok := secretKinds[kind]
	if !ok {
		return nil, invalid("invalid_kind", "不支持的 secret 类型")
	}
	if maxBytes <= 0 {
		maxBytes = MaxSecretBytesForKind(kind)
	}
	if len(payload) == 0 {
		return nil, invalid("invalid_payload", "请求体为空")
	}
	if len(payload) > maxBytes {
		return nil, invalid("payload_too_large", "加密数据超过 %d 字节限制", maxBytes)
	}
	if !json.Valid(payload) {
		return nil, invalid("invalid_payload", "请求体不是有效的 JSON")
	}

	var env struct {
		Version    int    `json:"version"`
		Kind       string `json:"kind"`
		Encrypted  bool   `json:"encrypted"`
		KeySource  string `json:"keySource"`
		Cipher     string `json:"cipher"`
		KDF        string `json:"kdf"`
		Iterations int    `json:"iterations"`
		Salt       string `json:"salt"`
		WrappedKey string `json:"wrappedKey"`
		Check      string `json:"check"`
		Data       string `json:"data"`
		Recovery   struct {
			WrappedKey string `json:"wrappedKey"`
		} `json:"recovery"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		return nil, invalid("invalid_payload", "加密 envelope 不是有效的 JSON")
	}

	if env.Version != SecretVersion {
		return nil, invalid("unsupported_version", "secret envelope 版本不受支持")
	}
	if !env.Encrypted {
		return nil, invalid("invalid_payload", "加密 envelope 缺少 encrypted=true")
	}
	if env.Kind != kind {
		return nil, invalid("secret_kind_mismatch", "密文用途与请求的 kind 不一致")
	}
	if env.Cipher != secretCipher {
		return nil, invalid("invalid_payload", "不支持的加密算法：%s", env.Cipher)
	}
	if env.KeySource != keySource {
		return nil, invalid("invalid_payload", "secret %s 的 keySource 必须是 %s", kind, keySource)
	}

	if err := validateSecretBase64("data", env.Data, 28, 0); err != nil {
		return nil, err
	}

	if keySource == "data-key" {
		// 主 dataKey 派生的子密钥不需要 PBKDF2 字段；出现即视为用途混淆。
		if env.KDF != "" || env.Iterations != 0 || env.Salt != "" || env.WrappedKey != "" ||
			env.Check != "" || env.Recovery.WrappedKey != "" {
			return nil, invalid("invalid_payload", "data-key secret 不应包含密码派生字段")
		}
		return payload, nil
	}

	if env.KDF != "pbkdf2-sha256" {
		return nil, invalid("invalid_payload", "不支持的 KDF：%s", env.KDF)
	}
	if env.Iterations < 100000 || env.Iterations > 2000000 {
		return nil, invalid("invalid_payload", "PBKDF2 迭代次数不在允许范围")
	}
	fields := []struct {
		name string
		raw  string
		min  int
		max  int
	}{
		{"salt", env.Salt, 16, 64},
		{"wrappedKey", env.WrappedKey, 60, 256},
		{"check", env.Check, 28, 512},
		{"recovery.wrappedKey", env.Recovery.WrappedKey, 60, 256},
	}
	for _, field := range fields {
		if err := validateSecretBase64(field.name, field.raw, field.min, field.max); err != nil {
			return nil, err
		}
	}
	return payload, nil
}

func validateSecretBase64(name, raw string, min, max int) error {
	if raw == "" {
		return invalid("invalid_payload", "加密 envelope 缺少 %s", name)
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return invalid("invalid_payload", "加密 envelope 的 %s 不是有效 Base64", name)
	}
	if len(decoded) < min || (max > 0 && len(decoded) > max) {
		return invalid("invalid_payload", "加密 envelope 的 %s 长度不正确", name)
	}
	return nil
}
