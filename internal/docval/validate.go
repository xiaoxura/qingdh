// Package docval validates the navigation document exchanged with the server.
// The server deliberately knows very little about the payload: it checks
// shape, size and URL safety so that sync stays schema-tolerant.
package docval

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"unicode/utf8"
)

// Limits applied to an incoming document.
const (
	MaxGroups = 50
	MaxLinks  = 500
	MaxTitle  = 40
	MaxName   = 20
	MaxIcon   = 200
	MaxURL    = 2048
)

// SupportedVersion is the plaintext payload version this server accepts.
const SupportedVersion = 2

// EncryptedVersion is the opaque, client-encrypted envelope version.
const EncryptedVersion = 3

// Error describes a validation failure with a stable machine-readable code.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func invalid(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Validate checks payload and returns it unchanged when valid. The returned
// value is the exact byte slice to store as jsonb.
func Validate(payload []byte, maxBytes int) ([]byte, error) {
	if len(payload) == 0 {
		return nil, invalid("invalid_payload", "请求体为空")
	}
	if len(payload) > maxBytes {
		return nil, invalid("payload_too_large", "导航数据超过 %d 字节限制", maxBytes)
	}
	if !json.Valid(payload) {
		return nil, invalid("invalid_payload", "请求体不是有效的 JSON")
	}

	var root map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(payload))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil {
		return nil, invalid("invalid_payload", "请求体必须是 JSON 对象")
	}

	var version int
	if raw, ok := root["version"]; !ok {
		return nil, invalid("unsupported_version", "缺少 payload version")
	} else if err := json.Unmarshal(raw, &version); err != nil {
		return nil, invalid("invalid_payload", "version 必须是数字")
	}
	if version == EncryptedVersion {
		if err := validateEncrypted(payload); err != nil {
			return nil, err
		}
		return payload, nil
	}
	if version != SupportedVersion {
		return nil, invalid("unsupported_version", "不支持的 payload version %d，请升级客户端", version)
	}

	if raw, ok := root["settings"]; ok && !isNull(raw) {
		if err := validateSettings(raw); err != nil {
			return nil, err
		}
	}

	rawGroups, ok := root["groups"]
	if !ok || isNull(rawGroups) {
		return nil, invalid("invalid_payload", "缺少 groups 数组")
	}
	var groups []json.RawMessage
	if err := json.Unmarshal(rawGroups, &groups); err != nil {
		return nil, invalid("invalid_payload", "groups 必须是数组")
	}
	if len(groups) > MaxGroups {
		return nil, invalid("too_many_groups", "分组数量超过 %d 个", MaxGroups)
	}

	seenGroups := make(map[string]bool, len(groups))
	seenLinks := make(map[string]bool)
	totalLinks := 0

	for i, rawGroup := range groups {
		var group struct {
			ID        string            `json:"id"`
			Name      string            `json:"name"`
			DeletedAt json.RawMessage   `json:"deletedAt"`
			Links     []json.RawMessage `json:"links"`
		}
		if err := json.Unmarshal(rawGroup, &group); err != nil {
			return nil, invalid("invalid_payload", "第 %d 个分组格式不正确", i+1)
		}
		if group.ID == "" {
			return nil, invalid("invalid_payload", "第 %d 个分组缺少 id", i+1)
		}
		if seenGroups[group.ID] {
			return nil, invalid("duplicate_id", "分组 id 重复：%s", group.ID)
		}
		seenGroups[group.ID] = true

		if !isNull(group.DeletedAt) {
			if utf8.RuneCountInString(group.Name) > MaxName {
				return nil, invalid("invalid_payload", "分组名称超过 %d 个字符", MaxName)
			}
			continue // deleted groups keep only their tombstone
		}

		if group.Name == "" {
			return nil, invalid("invalid_payload", "第 %d 个分组缺少名称", i+1)
		}
		if utf8.RuneCountInString(group.Name) > MaxName {
			return nil, invalid("invalid_payload", "分组名称超过 %d 个字符", MaxName)
		}

		if len(group.Links) > MaxLinks {
			return nil, invalid("too_many_links", "链接数量超过 %d 个", MaxLinks)
		}
		for j, rawLink := range group.Links {
			if err := validateLink(rawLink, seenLinks, i, j); err != nil {
				return nil, err
			}
			totalLinks++
			if totalLinks > MaxLinks {
				return nil, invalid("too_many_links", "链接数量超过 %d 个", MaxLinks)
			}
		}
	}

	return payload, nil
}

// validateEncrypted checks the outer encrypted envelope. The server cannot
// inspect the ciphertext, so it only verifies shape, sizes and the KDF.
func validateEncrypted(payload []byte) error {
	var env struct {
		Encrypted  bool   `json:"encrypted"`
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
		return invalid("invalid_payload", "加密 envelope 格式不正确")
	}
	if !env.Encrypted {
		return invalid("invalid_payload", "加密 envelope 缺少 encrypted=true")
	}
	if env.KDF != "pbkdf2-sha256" {
		return invalid("invalid_payload", "不支持的 KDF：%s", env.KDF)
	}
	if env.Iterations < 100000 || env.Iterations > 2000000 {
		return invalid("invalid_payload", "PBKDF2 迭代次数不在允许范围")
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
		{"data", env.Data, 28, 0},
		{"recovery.wrappedKey", env.Recovery.WrappedKey, 60, 256},
	}
	for _, field := range fields {
		if field.raw == "" {
			return invalid("invalid_payload", "加密 envelope 缺少 %s", field.name)
		}
		decoded, err := base64.StdEncoding.DecodeString(field.raw)
		if err != nil {
			return invalid("invalid_payload", "加密 envelope 的 %s 不是有效 Base64", field.name)
		}
		if len(decoded) < field.min || (field.max > 0 && len(decoded) > field.max) {
			return invalid("invalid_payload", "加密 envelope 的 %s 长度不正确", field.name)
		}
	}
	return nil
}

func validateSettings(raw json.RawMessage) error {
	var settings struct {
		Name   string `json:"name"`
		Engine string `json:"engine"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		return invalid("invalid_payload", "settings 格式不正确")
	}
	if utf8.RuneCountInString(settings.Name) > 12 {
		return invalid("invalid_payload", "昵称超过 12 个字符")
	}
	if len(settings.Engine) > 50 {
		return invalid("invalid_payload", "搜索引擎标识过长")
	}
	return nil
}

func validateLink(raw json.RawMessage, seen map[string]bool, groupIndex, linkIndex int) error {
	var link struct {
		ID        string          `json:"id"`
		URL       string          `json:"url"`
		Title     string          `json:"title"`
		Icon      string          `json:"icon"`
		DeletedAt json.RawMessage `json:"deletedAt"`
	}
	if err := json.Unmarshal(raw, &link); err != nil {
		return invalid("invalid_payload", "第 %d 组第 %d 个链接格式不正确", groupIndex+1, linkIndex+1)
	}
	label := fmt.Sprintf("第 %d 组第 %d 个链接", groupIndex+1, linkIndex+1)

	if link.ID == "" {
		return invalid("invalid_payload", "%s缺少 id", label)
	}
	if seen[link.ID] {
		return invalid("duplicate_id", "链接 id 重复：%s", link.ID)
	}
	seen[link.ID] = true

	if utf8.RuneCountInString(link.Title) > MaxTitle {
		return invalid("invalid_payload", "链接标题超过 %d 个字符", MaxTitle)
	}
	if len(link.Icon) > MaxIcon {
		return invalid("invalid_payload", "图标字段超过 %d 个字符", MaxIcon)
	}

	if !isNull(link.DeletedAt) {
		return nil // tombstone: URL may already be cleared
	}

	if link.URL == "" {
		return invalid("invalid_url", "%s缺少网址", label)
	}
	if len(link.URL) > MaxURL {
		return invalid("invalid_url", "%s网址过长", label)
	}
	parsed, err := url.Parse(link.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return invalid("invalid_url", "%s网址必须是以 http 或 https 开头的完整地址", label)
	}
	return nil
}

func isNull(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null"))
}
