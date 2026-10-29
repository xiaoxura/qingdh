package httpapi

import (
	"errors"
	"fmt"
	"html"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/XiaoXuRa/qingdh/internal/auth"
	"github.com/XiaoXuRa/qingdh/internal/mail"
	"github.com/XiaoXuRa/qingdh/internal/store"
)

const changeEmailTokenTTL = 24 * time.Hour

type emailChangeRequest struct {
	Password string `json:"password"`
	NewEmail string `json:"newEmail"`
}

// handleRequestEmailChange stores a pending address and mails a confirmation
// link to the NEW address. The account email only changes after that link is
// confirmed.
func (s *Server) handleRequestEmailChange(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	if !s.limiter.allow("email-change:"+user.ID.String(), limitEmailChangePerUser, burstEmailChangePerUser) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "操作过于频繁，请稍后再试")
		return
	}

	var req emailChangeRequest
	if !decodeJSON(w, r, &req, maxAuthBodyBytes) {
		return
	}
	if !s.settings.Get().SMTPConfigured() {
		writeError(w, http.StatusServiceUnavailable, "email_not_configured", "修改邮箱需要先由管理员配置邮件服务")
		return
	}

	newEmail, err := auth.NormalizeEmail(req.NewEmail)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid_email", err.Error())
		return
	}
	if newEmail == user.Email {
		writeError(w, http.StatusUnprocessableEntity, "same_email", "新邮箱与当前邮箱相同")
		return
	}

	verified, err := auth.VerifyPassword(req.Password, user.PasswordHash)
	if err != nil {
		if writePasswordBusy(w, err) {
			return
		}
		s.logger.Error("verify password for email change", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if !verified {
		writeError(w, http.StatusForbidden, "invalid_password", "密码不正确")
		return
	}

	base, baseErr := s.mailBaseURL(r)
	if baseErr != nil {
		s.logger.Warn("email change disabled: no trusted site URL", "user_id", user.ID.String())
		writeError(w, http.StatusServiceUnavailable, "email_not_configured", "管理员尚未设置站点地址，暂时无法发送确认邮件")
		return
	}

	// 与注册保持一致：邮箱已占用时明确返回 409。修改邮箱本身需要登录，
	// 枚举风险低于公开注册接口。
	if other, lookupErr := s.store.UserByEmail(r.Context(), newEmail); lookupErr == nil && other.ID != user.ID {
		writeError(w, http.StatusConflict, "email_taken", "这个邮箱已经注册过了")
		return
	} else if lookupErr != nil && !errors.Is(lookupErr, store.ErrNotFound) {
		s.logger.Error("lookup new email", "error", lookupErr, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	raw, hash, err := auth.NewToken()
	if err != nil {
		s.logger.Error("generate email change token", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if err := s.store.CreateEmailToken(r.Context(), user.ID, store.TokenChangeEmail, hash, s.now().Add(changeEmailTokenTTL)); err != nil {
		s.logger.Error("store email change token", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if _, err := s.store.SetPendingEmail(r.Context(), user.ID, newEmail); err != nil {
		s.logger.Error("set pending email", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if err := s.mailer.Send(r.Context(), mail.ChangeEmailMessage(base, newEmail, raw)); err != nil {
		s.logger.Error("send email change mail", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusBadGateway, "email_send_failed", "确认邮件发送失败，请稍后重试")
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]any{
		"status":       "sent",
		"pendingEmail": newEmail,
	})
}

// handleChangeEmailPage renders the confirmation form. A GET must not consume
// the single-use token, because mail scanners often prefetch links.
func (s *Server) handleChangeEmailPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	if !s.limiter.allow("email-change:ip:"+clientIPFrom(r), limitVerifyPerIP, burstVerifyPerIP) {
		s.renderChangeEmailPage(w, http.StatusTooManyRequests, "", "请求过于频繁，请稍后再试。")
		return
	}
	token := r.URL.Query().Get("token")
	if token == "" {
		s.renderChangeEmailPage(w, http.StatusUnprocessableEntity, "", "这个确认链接不完整，请回到邮件重新打开。")
		return
	}
	s.renderChangeEmailPage(w, http.StatusOK, token, "")
}

// handleChangeEmailForm is the only browser path that consumes a change-email
// token. It always redirects back to the app with a result flag.
func (s *Server) handleChangeEmailForm(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")

	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	if err := r.ParseForm(); err != nil {
		http.Redirect(w, r, "/?email_change=error", http.StatusSeeOther)
		return
	}
	if !s.limiter.allow("email-change:ip:"+clientIPFrom(r), limitVerifyPerIP, burstVerifyPerIP) {
		http.Redirect(w, r, "/?email_change=rate_limited", http.StatusSeeOther)
		return
	}

	var keepSession uuid.UUID
	if token := s.sessions.ReadToken(r, s.requestSecure(r)); token != "" {
		if sess, _, err := s.store.SessionByTokenHash(r.Context(), auth.HashToken(token)); err == nil {
			keepSession = sess.ID
		}
	}

	user, oldEmail, err := s.store.ConfirmEmailChange(r.Context(), auth.HashToken(r.PostFormValue("token")), keepSession)
	if err != nil {
		code := "error"
		switch {
		case errors.Is(err, store.ErrTokenInvalid):
			code = "expired"
		case errors.Is(err, store.ErrEmailTaken):
			code = "taken"
		case errors.Is(err, store.ErrPendingEmailChanged):
			code = "pending"
		default:
			s.logger.Error("confirm email change", "error", err)
		}
		http.Redirect(w, r, "/?email_change="+code, http.StatusSeeOther)
		return
	}

	s.audit(r.Context(), &user.ID, &user.ID, "account.email_change", nil)
	if s.settings.Get().SMTPConfigured() {
		if sendErr := s.mailer.Send(r.Context(), mail.EmailChangedNoticeMessage(oldEmail, user.Email)); sendErr != nil {
			s.logger.Error("send email changed notice", "error", sendErr, "user_id", user.ID.String())
		}
	}

	target := "/?email_changed=1"
	if keepSession == uuid.Nil {
		// No session for this account was present (e.g. opened on another
		// device): every session was revoked, so ask the user to log in again.
		target += "&login=1"
		s.clearSessionCookies(w)
	}
	http.Redirect(w, r, target, http.StatusSeeOther)
}

func (s *Server) renderChangeEmailPage(w http.ResponseWriter, status int, token, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	body := ""
	if token != "" {
		body = fmt.Sprintf(`<form method="post" action="/change-email"><input type="hidden" name="token" value="%s"><button type="submit">确认新邮箱</button></form><p class="hint">链接 24 小时内有效，只能使用一次。</p>`, html.EscapeString(token))
	}
	if message != "" {
		body = `<p class="hint">` + html.EscapeString(message) + `</p>`
	}
	_, _ = fmt.Fprintf(w, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>确认新邮箱 · 氢导航</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6fa;color:#1b1e24;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}main{width:min(92vw,420px);padding:32px;background:#fff;border-radius:18px;box-shadow:0 18px 50px rgba(28,35,60,.12);text-align:center}h1{margin:0 0 10px;font-size:22px}p{line-height:1.7;color:#4b5563}.hint{font-size:13px;color:#6b7280}button{width:100%%;margin:18px 0 6px;padding:12px 18px;border:0;border-radius:10px;background:#4f6bf5;color:#fff;font-size:15px;cursor:pointer}</style>
</head><body><main><h1>确认新邮箱</h1><p>确认后账号邮箱会立即更新，其他设备将退出登录。</p>%s</main></body></html>`, body)
}
