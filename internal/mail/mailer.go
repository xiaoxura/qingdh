// Package mail sends transactional email over SMTP and renders the messages
// used by the account flows.
package mail

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/wneessen/go-mail"
)

// Message is a single outbound email.
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

// Mailer sends messages. Tests use a fake implementation.
type Mailer interface {
	Send(ctx context.Context, msg Message) error
}

// Noop logs instead of sending. It is used when SMTP is not configured.
type Noop struct {
	Logger *slog.Logger
}

// Send implements Mailer.
func (n Noop) Send(_ context.Context, msg Message) error {
	n.Logger.Info("mail not configured; message dropped", "to", msg.To, "subject", msg.Subject)
	return nil
}

// SMTPConfig describes the outbound mail server. It is stored in the admin
// settings table, not in config.yml.
type SMTPConfig struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	TLSMode  string // "auto", "starttls", "tls", "none"
}

// SMTP delivers messages using the configured server.
type SMTP struct {
	cfg    SMTPConfig
	logger *slog.Logger
}

// NewSMTP builds an SMTP mailer.
func NewSMTP(cfg SMTPConfig, logger *slog.Logger) *SMTP {
	return &SMTP{cfg: cfg, logger: logger}
}

// Provider returns the current SMTP configuration. ok is false when the
// administrator has not configured email yet.
type Provider func() (SMTPConfig, bool)

// Dynamic reads the SMTP configuration for every message, so admin changes
// take effect without a restart.
type Dynamic struct {
	provider Provider
	logger   *slog.Logger
}

// NewDynamic builds a mailer backed by a settings provider.
func NewDynamic(provider Provider, logger *slog.Logger) *Dynamic {
	return &Dynamic{provider: provider, logger: logger}
}

// Send implements Mailer.
func (d *Dynamic) Send(ctx context.Context, msg Message) error {
	cfg, ok := d.provider()
	if !ok {
		d.logger.Info("mail not configured; message dropped", "to", msg.To, "subject", msg.Subject)
		return nil
	}
	return NewSMTP(cfg, d.logger).Send(ctx, msg)
}

// Send implements Mailer.
func (s *SMTP) Send(ctx context.Context, msg Message) error {
	m := mail.NewMsg()
	if err := m.From(s.cfg.From); err != nil {
		return fmt.Errorf("mail from: %w", err)
	}
	if err := m.To(msg.To); err != nil {
		return fmt.Errorf("mail to: %w", err)
	}
	m.Subject(msg.Subject)
	m.SetBodyString(mail.TypeTextPlain, msg.Text)
	if msg.HTML != "" {
		m.AddAlternativeString(mail.TypeTextHTML, msg.HTML)
	}

	opts := []mail.Option{
		mail.WithPort(s.cfg.Port),
		mail.WithTimeout(15 * time.Second),
	}
	if s.cfg.Username != "" {
		opts = append(opts,
			mail.WithSMTPAuth(mail.SMTPAuthAutoDiscover),
			mail.WithUsername(s.cfg.Username),
			mail.WithPassword(s.cfg.Password),
		)
	}

	// Never fall back to plaintext unless explicitly requested: a downgrade
	// would leak SMTP credentials.
	switch s.cfg.TLSMode {
	case "none":
		opts = append(opts, mail.WithTLSPolicy(mail.NoTLS))
	case "tls":
		opts = append(opts, mail.WithSSL(), mail.WithTLSPolicy(mail.TLSMandatory))
	case "starttls":
		opts = append(opts, mail.WithTLSPolicy(mail.TLSMandatory))
	default: // auto
		if s.cfg.Port == 465 {
			opts = append(opts, mail.WithSSL(), mail.WithTLSPolicy(mail.TLSMandatory))
		} else {
			opts = append(opts, mail.WithTLSPolicy(mail.TLSMandatory))
		}
	}

	client, err := mail.NewClient(s.cfg.Host, opts...)
	if err != nil {
		return fmt.Errorf("mail client: %w", err)
	}

	if err := client.DialAndSendWithContext(ctx, m); err != nil {
		return fmt.Errorf("send mail: %w", err)
	}
	s.logger.Info("mail sent", "to", msg.To, "subject", msg.Subject)
	return nil
}

// VerificationLink builds the browser URL used to confirm an address.
func VerificationLink(base *url.URL, token string) string {
	return base.String() + "/verify-email?token=" + url.QueryEscape(token)
}

// ResetLink builds the URL that opens the password reset screen.
func ResetLink(base *url.URL, token string) string {
	return base.String() + "/?reset_token=" + url.QueryEscape(token)
}

// VerificationMessage renders the signup confirmation email.
func VerificationMessage(base *url.URL, to, token string) Message {
	link := VerificationLink(base, token)
	text := strings.Join([]string{
		"你好，",
		"",
		"感谢注册氢导航。请打开下面的链接完成邮箱验证：",
		link,
		"",
		"链接 24 小时内有效，只能使用一次。",
		"如果这不是你本人的操作，忽略这封邮件即可。",
	}, "\n")

	html := fmt.Sprintf(`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:15px;line-height:1.7;color:#1b1e24;max-width:520px">
<p>你好，</p>
<p>感谢注册<b>氢导航</b>。请点击下面的按钮完成邮箱验证：</p>
<p style="margin:22px 0"><a href="%s" style="display:inline-block;background:#4f6bf5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px">验证邮箱</a></p>
<p style="color:#6b7280;font-size:13px">按钮无法点击时，复制这个地址到浏览器打开：<br><span style="word-break:break-all">%s</span></p>
<p style="color:#6b7280;font-size:13px">链接 24 小时内有效，只能使用一次。如果这不是你本人的操作，忽略这封邮件即可。</p>
</div>`, link, link)

	return Message{To: to, Subject: "验证你的氢导航邮箱", Text: text, HTML: html}
}

// ResetMessage renders the password reset email.
func ResetMessage(base *url.URL, to, token string) Message {
	link := ResetLink(base, token)
	text := strings.Join([]string{
		"你好，",
		"",
		"我们收到了一重置密码的请求。打开下面的链接设置新密码：",
		link,
		"",
		"链接 30 分钟内有效，只能使用一次。",
		"如果这不是你本人的操作，可以忽略这封邮件，你的密码不会被修改。",
	}, "\n")

	html := fmt.Sprintf(`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:15px;line-height:1.7;color:#1b1e24;max-width:520px">
<p>你好，</p>
<p>我们收到了一次重置氢导航密码的请求。点击下面的按钮设置新密码：</p>
<p style="margin:22px 0"><a href="%s" style="display:inline-block;background:#4f6bf5;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px">设置新密码</a></p>
<p style="color:#6b7280;font-size:13px">按钮无法点击时，复制这个地址到浏览器打开：<br><span style="word-break:break-all">%s</span></p>
<p style="color:#6b7280;font-size:13px">链接 30 分钟内有效，只能使用一次。如果这不是你本人的操作，可以忽略这封邮件，你的密码不会被修改。</p>
</div>`, link, link)

	return Message{To: to, Subject: "重置你的氢导航密码", Text: text, HTML: html}
}

// PasswordChangedMessage notifies the account owner after a reset.
func PasswordChangedMessage(to string) Message {
	text := "你的氢导航密码刚刚被重置，所有设备都已退出登录。\n\n如果这不是你本人的操作，请立即通过邮箱验证流程重新找回账号。"
	html := `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:15px;line-height:1.7;color:#1b1e24;max-width:520px">
<p>你的氢导航密码刚刚被重置，所有设备都已退出登录。</p>
<p style="color:#6b7280;font-size:13px">如果这不是你本人的操作，请立即通过邮箱验证流程重新找回账号。</p>
</div>`
	return Message{To: to, Subject: "氢导航密码已重置", Text: text, HTML: html}
}
