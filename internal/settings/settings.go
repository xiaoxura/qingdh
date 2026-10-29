// Package settings stores site-wide runtime configuration in PostgreSQL so
// that administrators can change it without restarting the service or editing
// config.yml.
package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	netmail "net/mail"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/XiaoXuRa/qingdh/internal/mail"
	"github.com/XiaoXuRa/qingdh/internal/store"
)

// Values is the full set of runtime-configurable settings.
//
// Durations are stored in seconds to keep the JSON stable and easy to edit.
type Values struct {
	// SiteName and SiteLogo are public branding shown by the app and admin UI.
	SiteName string `json:"siteName"`
	SiteLogo string `json:"siteLogo"`
	// BaseURL is the canonical public URL. When empty the server falls back to
	// the address of the incoming request.
	BaseURL                  string `json:"baseUrl"`
	AllowRegistration        bool   `json:"allowRegistration"`
	RequireEmailVerification bool   `json:"requireEmailVerification"`
	SMTPHost                 string `json:"smtpHost"`
	SMTPPort                 int    `json:"smtpPort"`
	SMTPUsername             string `json:"smtpUsername"`
	SMTPPassword             string `json:"smtpPassword"`
	SMTPFrom                 string `json:"smtpFrom"`
	SMTPTLS                  string `json:"smtpTls"`
	SessionIdleSeconds       int64  `json:"sessionIdleSeconds"`
	SessionAbsoluteSeconds   int64  `json:"sessionAbsoluteSeconds"`
	SessionRenewSeconds      int64  `json:"sessionRenewSeconds"`
	// AIDailyLimit caps proxied AI requests per user per day (0 = use default).
	AIDailyLimit int `json:"aiDailyLimit"`
	// Version is the database row version used for optimistic concurrency.
	Version int64 `json:"version"`
}

// Default returns the values used for a fresh installation.
func Default() Values {
	return Values{
		SiteName:                 "氢导航",
		AllowRegistration:        true,
		RequireEmailVerification: true,
		SMTPPort:                 587,
		SMTPTLS:                  "auto",
		SessionIdleSeconds:       int64(14 * 24 * time.Hour / time.Second),
		SessionAbsoluteSeconds:   int64(180 * 24 * time.Hour / time.Second),
		SessionRenewSeconds:      int64(time.Hour / time.Second),
		AIDailyLimit:             200,
	}
}

// BaseURLValue returns the configured public URL, or nil when the server
// should derive it from the request.
func (v Values) BaseURLValue() *url.URL {
	if v.BaseURL == "" {
		return nil
	}
	parsed, err := url.Parse(v.BaseURL)
	if err != nil || parsed.Host == "" {
		return nil
	}
	return parsed
}

// SMTPConfigured reports whether outbound email can be attempted.
func (v Values) SMTPConfigured() bool {
	return strings.TrimSpace(v.SMTPHost) != "" && strings.TrimSpace(v.SMTPFrom) != ""
}

// VerificationRequired reports whether new accounts must confirm their email.
// Without SMTP the requirement is ignored so that registration keeps working.
func (v Values) VerificationRequired() bool {
	return v.RequireEmailVerification && v.SMTPConfigured()
}

// SMTPConfig converts the settings into the mailer configuration.
func (v Values) SMTPConfig() mail.SMTPConfig {
	return mail.SMTPConfig{
		Host:     strings.TrimSpace(v.SMTPHost),
		Port:     v.SMTPPort,
		Username: strings.TrimSpace(v.SMTPUsername),
		Password: v.SMTPPassword,
		From:     strings.TrimSpace(v.SMTPFrom),
		TLSMode:  v.SMTPTLS,
	}
}

// Durations returns the sliding session lifetimes.
func (v Values) Durations() (idle, absolute, renew time.Duration) {
	return time.Duration(v.SessionIdleSeconds) * time.Second,
		time.Duration(v.SessionAbsoluteSeconds) * time.Second,
		time.Duration(v.SessionRenewSeconds) * time.Second
}

// Validate checks ranges and formats before saving.
func (v *Values) Validate() error {
	v.SiteName = strings.TrimSpace(v.SiteName)
	if v.SiteName == "" {
		v.SiteName = "氢导航"
	}
	if len([]rune(v.SiteName)) > 40 {
		return fmt.Errorf("站点名称不能超过 40 个字符")
	}
	v.SiteLogo = strings.TrimSpace(v.SiteLogo)
	if v.SiteLogo != "" {
		if len(v.SiteLogo) > 192*1024 {
			return fmt.Errorf("站点 Logo 不能超过 128 KiB")
		}
		if strings.HasPrefix(v.SiteLogo, "data:") {
			allowed := []string{"data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,"}
			ok := false
			for _, prefix := range allowed {
				if strings.HasPrefix(v.SiteLogo, prefix) {
					ok = true
					break
				}
			}
			if !ok {
				return fmt.Errorf("logo 只支持 PNG、JPEG、WebP 或 GIF")
			}
		} else {
			parsed, err := url.Parse(v.SiteLogo)
			if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
				return fmt.Errorf("logo 必须是 http(s) 地址或上传的图片")
			}
		}
	}

	v.BaseURL = strings.TrimRight(strings.TrimSpace(v.BaseURL), "/")
	if v.BaseURL != "" {
		parsed, err := url.Parse(v.BaseURL)
		if err != nil || parsed.Host == "" {
			return fmt.Errorf("站点地址不是合法 URL")
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return fmt.Errorf("站点地址必须使用 http 或 https")
		}
		if (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
			return fmt.Errorf("站点地址不能包含路径、查询参数或片段")
		}
		parsed.Path = ""
		v.BaseURL = parsed.Scheme + "://" + parsed.Host
	}

	v.SMTPHost = strings.TrimSpace(v.SMTPHost)
	v.SMTPFrom = strings.TrimSpace(v.SMTPFrom)
	v.SMTPUsername = strings.TrimSpace(v.SMTPUsername)
	v.SMTPTLS = strings.ToLower(strings.TrimSpace(v.SMTPTLS))

	if v.SMTPHost != "" {
		if v.SMTPPort < 1 || v.SMTPPort > 65535 {
			return fmt.Errorf("SMTP 端口必须在 1-65535 之间")
		}
		if v.SMTPFrom == "" {
			return fmt.Errorf("配置 SMTP 时必须填写发件人地址")
		}
		if _, err := netmail.ParseAddress(v.SMTPFrom); err != nil {
			return fmt.Errorf("发件人地址格式不正确")
		}
	}
	switch v.SMTPTLS {
	case "auto", "starttls", "tls", "none":
	default:
		return fmt.Errorf("SMTP_TLS 只能是 auto、starttls、tls 或 none")
	}

	if v.SessionIdleSeconds < 3600 {
		return fmt.Errorf("会话闲置时间不能少于 1 小时")
	}
	if v.SessionAbsoluteSeconds < v.SessionIdleSeconds {
		return fmt.Errorf("会话绝对上限不能小于闲置时间")
	}
	if v.SessionRenewSeconds < 60 {
		return fmt.Errorf("会话续期间隔不能少于 1 分钟")
	}
	if v.SessionRenewSeconds > v.SessionIdleSeconds {
		return fmt.Errorf("会话续期间隔不能大于闲置时间")
	}
	if v.AIDailyLimit <= 0 {
		v.AIDailyLimit = 200
	}
	if v.AIDailyLimit > 10000 {
		return fmt.Errorf("AI 每日调用上限不能超过 10000")
	}
	return nil
}

// Service caches the current settings and refreshes them periodically so that
// several instances eventually converge after an admin change.
type Service struct {
	store  *store.Store
	logger *slog.Logger

	mu     sync.RWMutex
	values Values
}

// New loads settings from the database, falling back to defaults.
func New(ctx context.Context, st *store.Store, logger *slog.Logger) (*Service, error) {
	s := &Service{store: st, logger: logger, values: Default()}
	if err := s.Reload(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// Get returns the cached values.
func (s *Service) Get() Values {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.values
}

// Reload re-reads the settings row.
func (s *Service) Reload(ctx context.Context) error {
	raw, version, err := s.store.GetSettingsVersioned(ctx, store.SettingsKey)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			s.set(Default())
			return nil
		}
		return err
	}

	values := Default()
	if err := json.Unmarshal(raw, &values); err != nil {
		return fmt.Errorf("parse site settings: %w", err)
	}
	values.Version = version
	if err := values.Validate(); err != nil {
		// Never take a running service down because of a bad row; keep the
		// previous values and report loudly.
		s.logger.Error("stored settings are invalid; keeping previous values", "error", err)
		return nil
	}
	s.set(values)
	return nil
}

// Update persists new values unconditionally. It is the internal/test path;
// HTTP admin writes go through UpdateVersioned.
func (s *Service) Update(ctx context.Context, values Values) error {
	if err := values.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(values)
	if err != nil {
		return err
	}
	version, err := s.store.PutSettings(ctx, store.SettingsKey, raw)
	if err != nil {
		return err
	}
	values.Version = version
	s.set(values)
	return nil
}

// UpdateVersioned persists values only when base matches the stored version.
// It returns store.ErrConflict for a stale admin tab.
func (s *Service) UpdateVersioned(ctx context.Context, values Values, base int64) error {
	if err := values.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(values)
	if err != nil {
		return err
	}
	version, err := s.store.PutSettingsVersioned(ctx, store.SettingsKey, raw, base)
	if err != nil {
		return err
	}
	values.Version = version
	s.set(values)
	return nil
}

func (s *Service) set(values Values) {
	s.mu.Lock()
	s.values = values
	s.mu.Unlock()
}

// StartRefresher reloads settings every interval until the context is done.
func (s *Service) StartRefresher(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refreshCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			if err := s.Reload(refreshCtx); err != nil {
				s.logger.Warn("refresh settings failed", "error", err)
			}
			cancel()
		}
	}
}
