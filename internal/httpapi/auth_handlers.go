package httpapi

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"time"

	"github.com/XiaoXuRa/qingdh/internal/auth"
	"github.com/XiaoXuRa/qingdh/internal/mail"
	"github.com/XiaoXuRa/qingdh/internal/store"
)

const (
	maxAuthBodyBytes = 8 << 10
	verifyTokenTTL   = 24 * time.Hour
	resetTokenTTL    = 30 * time.Minute
)

type registerRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	values := s.settings.Get()
	if !values.AllowRegistration {
		writeError(w, http.StatusForbidden, "registration_disabled", "当前实例未开放注册")
		return
	}

	var req registerRequest
	if !decodeJSON(w, r, &req, maxAuthBodyBytes) {
		return
	}

	email, err := auth.NormalizeEmail(req.Email)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid_email", err.Error())
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "weak_password", err.Error())
		return
	}
	if !s.limiter.allow("register:ip:"+clientIPFrom(r), limitRegisterPerIP, burstRegisterPerIP) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "注册过于频繁，请稍后再试")
		return
	}
	if values.VerificationRequired() {
		// 未配置站点地址/可信 Host 时不能生成可信的验证链接，提前拒绝，
		// 避免创建出一个收不到验证邮件的账号。
		if _, baseErr := s.mailBaseURL(r); baseErr != nil {
			s.logger.Warn("verification email disabled: no trusted site URL")
			writeError(w, http.StatusServiceUnavailable, "email_not_configured", "管理员尚未设置站点地址，暂时无法发送验证邮件")
			return
		}
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		if writePasswordBusy(w, err) {
			return
		}
		s.logger.Error("hash password", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	user, err := s.store.CreateUser(r.Context(), email, hash)
	if err != nil {
		if errors.Is(err, store.ErrEmailTaken) {
			writeError(w, http.StatusConflict, "email_taken", "这个邮箱已经注册过了")
			return
		}
		s.logger.Error("create user", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	if values.VerificationRequired() {
		base, baseErr := s.mailBaseURL(r)
		if baseErr != nil {
			s.logger.Error("send verification mail: missing base URL", "user_id", user.ID.String())
			writeError(w, http.StatusServiceUnavailable, "email_not_configured", "管理员尚未设置站点地址，暂时无法发送验证邮件")
			return
		}
		if err := s.sendVerification(r.Context(), user, base); err != nil {
			s.logger.Error("send verification mail", "error", err, "user_id", user.ID.String())
			writeError(w, http.StatusBadGateway, "email_send_failed", "验证邮件发送失败，请稍后重新发送")
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{
			"status": "verification_sent",
			"email":  user.Email,
		})
		return
	}

	// Without the verification switch there is nothing to confirm; treat the
	// address as verified so the account UI stays consistent.
	if verified, verifyErr := s.store.MarkEmailVerified(r.Context(), user.ID, s.now()); verifyErr == nil {
		user = verified
	} else {
		s.logger.Error("mark email verified", "error", verifyErr, "user_id", user.ID.String())
	}

	started, err := s.sessions.Start(r.Context(), user.ID, s.ensureDeviceID(w, r), r.UserAgent(), clientIPFrom(r))
	if err != nil {
		s.logger.Error("start session", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	http.SetCookie(w, s.sessions.Cookie(started.Token, started.Session.ExpiresAt, s.requestSecure(r)))

	sess := toSessionDTO(started.Session)
	writeJSON(w, http.StatusCreated, map[string]any{
		"user":    s.authUserDTO(user),
		"session": sess,
	})
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !decodeJSON(w, r, &req, maxAuthBodyBytes) {
		return
	}

	ip := clientIPFrom(r)
	if !s.limiter.allow("login:ip:"+ip, limitLoginPerIP, burstLoginPerIP) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "尝试次数过多，请稍后再试")
		return
	}

	email, err := auth.NormalizeEmail(req.Email)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "邮箱或密码不正确")
		return
	}
	if !s.limiter.allow("login:email:"+email, limitLoginPerEmail, burstLoginPerEmail) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "尝试次数过多，请稍后再试")
		return
	}

	user, lookupErr := s.store.UserByEmail(r.Context(), email)
	if lookupErr != nil && !errors.Is(lookupErr, store.ErrNotFound) {
		s.logger.Error("lookup user", "error", lookupErr)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	// Always verify against a hash so that response time does not leak whether
	// the account exists.
	hash := s.dummyHash
	if lookupErr == nil {
		hash = user.PasswordHash
	}
	ok, verifyErr := auth.VerifyPassword(req.Password, hash)
	if verifyErr != nil {
		if writePasswordBusy(w, verifyErr) {
			return
		}
		if lookupErr == nil {
			s.logger.Error("verify stored hash", "error", verifyErr, "user_id", user.ID.String())
			writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
			return
		}
	}
	if lookupErr != nil || !ok {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "邮箱或密码不正确")
		return
	}

	if user.DisabledAt != nil {
		writeError(w, http.StatusForbidden, "account_disabled", "账号已被禁用，请联系管理员")
		return
	}

	if s.settings.Get().VerificationRequired() && !user.Verified() {
		writeError(w, http.StatusForbidden, "email_not_verified", "请先完成邮箱验证")
		return
	}

	started, err := s.sessions.Start(r.Context(), user.ID, s.ensureDeviceID(w, r), r.UserAgent(), ip)
	if err != nil {
		s.logger.Error("start session", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	http.SetCookie(w, s.sessions.Cookie(started.Token, started.Session.ExpiresAt, s.requestSecure(r)))

	writeJSON(w, http.StatusOK, map[string]any{
		"user":    s.authUserDTO(user),
		"session": toSessionDTO(started.Session),
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	token := s.sessions.ReadToken(r, s.requestSecure(r))
	if token != "" {
		if sess, _, err := s.store.SessionByTokenHash(r.Context(), auth.HashToken(token)); err == nil {
			if err := s.store.DeleteSession(r.Context(), sess.ID); err != nil {
				s.logger.Error("delete session", "error", err)
			}
		}
	}
	s.clearSessionCookies(w)
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	sess, _ := sessionFrom(r.Context())

	writeJSON(w, http.StatusOK, map[string]any{
		"user":    s.authUserDTO(user),
		"session": toSessionDTO(sess),
	})
}

// handleRefresh forces a renewal, used by the client after being idle and by
// the "立即同步" style actions.
func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	sess, ok := sessionFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}

	idleTTL, absoluteTTL, _ := s.settings.Get().Durations()
	expiry, err := s.store.RenewSession(r.Context(), sess.ID, idleTTL, absoluteTTL, 0)
	if err != nil {
		s.logger.Error("renew session", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if expiry == nil {
		// The absolute lifetime was reached; the next request will be rejected.
		writeJSON(w, http.StatusOK, map[string]any{"expiresAt": sess.ExpiresAt})
		return
	}

	http.SetCookie(w, s.sessions.Cookie(s.sessions.ReadToken(r, s.requestSecure(r)), *expiry, s.requestSecure(r)))
	writeJSON(w, http.StatusOK, map[string]any{"expiresAt": *expiry})
}

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// handleChangePassword is the logged-in self-service password change. The
// current session survives; every other device is signed out.
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	if !s.limiter.allow("password:"+user.ID.String(), limitPasswordPerUser, burstPasswordPerUser) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "操作过于频繁，请稍后再试")
		return
	}

	var req changePasswordRequest
	if !decodeJSON(w, r, &req, maxAuthBodyBytes) {
		return
	}

	verified, err := auth.VerifyPassword(req.CurrentPassword, user.PasswordHash)
	if err != nil {
		if writePasswordBusy(w, err) {
			return
		}
		s.logger.Error("verify current password", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if !verified {
		writeError(w, http.StatusForbidden, "invalid_password", "当前密码不正确")
		return
	}
	if req.NewPassword == req.CurrentPassword {
		writeError(w, http.StatusUnprocessableEntity, "same_password", "新密码不能与当前密码相同")
		return
	}
	if err := auth.ValidatePassword(req.NewPassword); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "weak_password", err.Error())
		return
	}

	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		if writePasswordBusy(w, err) {
			return
		}
		s.logger.Error("hash new password", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	current, _ := sessionFrom(r.Context())
	if err := s.store.UpdatePasswordAndRevokeOtherSessions(r.Context(), user.ID, hash, current.ID); err != nil {
		s.logger.Error("update password and revoke sessions", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	s.audit(r.Context(), &user.ID, &user.ID, "account.password_change", map[string]any{"keptCurrentSession": true})

	if s.settings.Get().SMTPConfigured() {
		if sendErr := s.mailer.Send(r.Context(), mail.PasswordChangeNoticeMessage(user.Email)); sendErr != nil {
			s.logger.Error("send password changed mail", "error", sendErr, "user_id", user.ID.String())
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

type verifyRequest struct {
	Token string `json:"token"`
}

func (s *Server) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req verifyRequest
	if !decodeJSON(w, r, &req, maxAuthBodyBytes) {
		return
	}
	if !s.limiter.allow("verify:ip:"+clientIPFrom(r), limitVerifyPerIP, burstVerifyPerIP) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "请求过于频繁，请稍后再试")
		return
	}

	user, err := s.verifyEmailToken(r.Context(), req.Token)
	if err != nil {
		s.writeVerifyError(w, err)
		return
	}

	started, err := s.sessions.Start(r.Context(), user.ID, s.ensureDeviceID(w, r), r.UserAgent(), clientIPFrom(r))
	if err != nil {
		s.logger.Error("start session", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	http.SetCookie(w, s.sessions.Cookie(started.Token, started.Session.ExpiresAt, s.requestSecure(r)))

	writeJSON(w, http.StatusOK, map[string]any{
		"user":    s.authUserDTO(user),
		"session": toSessionDTO(started.Session),
	})
}

// handleVerifyEmailPage renders a confirmation page. Mail scanners and link
// previews often fetch the URL in an email before the user clicks it; a GET
// must therefore never consume the single-use token or mint a session.
func (s *Server) handleVerifyEmailPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	if !s.limiter.allow("verify:ip:"+clientIPFrom(r), limitVerifyPerIP, burstVerifyPerIP) {
		s.renderVerifyPage(w, http.StatusTooManyRequests, "", "请求过于频繁，请稍后再试。")
		return
	}
	token := r.URL.Query().Get("token")
	if token == "" {
		s.renderVerifyPage(w, http.StatusUnprocessableEntity, "", "这个验证链接不完整，请回到邮件重新打开。")
		return
	}
	s.renderVerifyPage(w, http.StatusOK, token, "")
}

// handleVerifyEmailForm is the POST target of the confirmation page. It is the
// only browser path that consumes a verification token.
func (s *Server) handleVerifyEmailForm(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")

	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	if err := r.ParseForm(); err != nil {
		http.Redirect(w, r, "/?verify=error", http.StatusSeeOther)
		return
	}
	if !s.limiter.allow("verify:ip:"+clientIPFrom(r), limitVerifyPerIP, burstVerifyPerIP) {
		http.Redirect(w, r, "/?verify=rate_limited", http.StatusSeeOther)
		return
	}

	user, err := s.verifyEmailToken(r.Context(), r.PostFormValue("token"))
	if err != nil {
		s.logger.Info("email verification failed", "error", err)
		http.Redirect(w, r, "/?verify=error", http.StatusSeeOther)
		return
	}

	started, err := s.sessions.Start(r.Context(), user.ID, s.ensureDeviceID(w, r), r.UserAgent(), clientIPFrom(r))
	if err != nil {
		s.logger.Error("start session after verification", "error", err)
		http.Redirect(w, r, "/?verify=error", http.StatusSeeOther)
		return
	}
	http.SetCookie(w, s.sessions.Cookie(started.Token, started.Session.ExpiresAt, s.requestSecure(r)))
	http.Redirect(w, r, "/?verified=1", http.StatusSeeOther)
}

func (s *Server) renderVerifyPage(w http.ResponseWriter, status int, token, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	body := ""
	if token != "" {
		body = fmt.Sprintf(`<form method="post" action="/verify-email"><input type="hidden" name="token" value="%s"><button type="submit">确认验证</button></form><p class="hint">链接 24 小时内有效，只能使用一次。</p>`, html.EscapeString(token))
	}
	if message != "" {
		body = `<p class="hint">` + html.EscapeString(message) + `</p>`
	}
	_, _ = fmt.Fprintf(w, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>验证邮箱 · 氢导航</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6fa;color:#1b1e24;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}main{width:min(92vw,420px);padding:32px;background:#fff;border-radius:18px;box-shadow:0 18px 50px rgba(28,35,60,.12);text-align:center}h1{margin:0 0 10px;font-size:22px}p{line-height:1.7;color:#4b5563}.hint{font-size:13px;color:#6b7280}button{width:100%%;margin:18px 0 6px;padding:12px 18px;border:0;border-radius:10px;background:#4f6bf5;color:#fff;font-size:15px;cursor:pointer}</style>
</head><body><main><h1>验证邮箱</h1><p>点击下面的按钮完成验证，并在这台设备上登录。</p>%s</main></body></html>`, body)
}

func (s *Server) verifyEmailToken(ctx context.Context, raw string) (store.User, error) {
	if raw == "" {
		return store.User{}, store.ErrTokenInvalid
	}
	userID, err := s.store.ConsumeEmailToken(ctx, store.TokenVerifyEmail, auth.HashToken(raw))
	if err != nil {
		return store.User{}, err
	}
	user, err := s.store.MarkEmailVerified(ctx, userID, s.now())
	if err != nil {
		return store.User{}, err
	}
	return user, nil
}

func (s *Server) writeVerifyError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrTokenInvalid) {
		writeError(w, http.StatusUnprocessableEntity, "invalid_token", "验证链接无效或已过期，请重新发送")
		return
	}
	s.logger.Error("verify email", "error", err)
	writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
}

type emailRequest struct {
	Email string `json:"email"`
}

func (s *Server) handleResendVerification(w http.ResponseWriter, r *http.Request) {
	var req emailRequest
	if !decodeJSON(w, r, &req, maxAuthBodyBytes) {
		return
	}

	ip := clientIPFrom(r)
	if !s.limiter.allow("email:ip:"+ip, limitEmailPerIP, burstEmailPerIP) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "请求过于频繁，请稍后再试")
		return
	}

	email, err := auth.NormalizeEmail(req.Email)
	if err != nil {
		// Do not disclose whether the address exists.
		writeJSON(w, http.StatusAccepted, map[string]any{"status": "sent"})
		return
	}
	if !s.limiter.allow("email:addr:"+email, limitEmailPerEmail, burstEmailPerEmail) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "请求过于频繁，请稍后再试")
		return
	}

	if s.settings.Get().SMTPConfigured() {
		base, baseErr := s.mailBaseURL(r)
		if baseErr != nil {
			s.logger.Warn("resend verification skipped: no trusted site URL")
		} else if user, err := s.store.UserByEmail(r.Context(), email); err == nil && !user.Verified() {
			if sendErr := s.sendVerification(r.Context(), user, base); sendErr != nil {
				s.logger.Error("resend verification", "error", sendErr, "user_id", user.ID.String())
			}
		}
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "sent"})
}

func (s *Server) handleForgotPassword(w http.ResponseWriter, r *http.Request) {
	var req emailRequest
	if !decodeJSON(w, r, &req, maxAuthBodyBytes) {
		return
	}

	ip := clientIPFrom(r)
	if !s.limiter.allow("email:ip:"+ip, limitEmailPerIP, burstEmailPerIP) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "请求过于频繁，请稍后再试")
		return
	}

	email, err := auth.NormalizeEmail(req.Email)
	if err == nil && s.settings.Get().SMTPConfigured() {
		if !s.limiter.allow("email:addr:"+email, limitEmailPerEmail, burstEmailPerEmail) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "请求过于频繁，请稍后再试")
			return
		}
		base, baseErr := s.mailBaseURL(r)
		if baseErr != nil {
			s.logger.Warn("password reset email skipped: no trusted site URL")
		} else if user, lookupErr := s.store.UserByEmail(r.Context(), email); lookupErr == nil {
			raw, hash, tokenErr := auth.NewToken()
			if tokenErr != nil {
				s.logger.Error("generate reset token", "error", tokenErr)
			} else if storeErr := s.store.CreateEmailToken(r.Context(), user.ID, store.TokenResetPassword, hash, s.now().Add(resetTokenTTL)); storeErr != nil {
				s.logger.Error("store reset token", "error", storeErr)
			} else if sendErr := s.mailer.Send(r.Context(), mail.ResetMessage(base, user.Email, raw)); sendErr != nil {
				s.logger.Error("send reset mail", "error", sendErr, "user_id", user.ID.String())
			}
		}
	}

	// Always the same answer to avoid account enumeration.
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "sent"})
}

type resetRequest struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	var req resetRequest
	if !decodeJSON(w, r, &req, maxAuthBodyBytes) {
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "weak_password", err.Error())
		return
	}

	userID, err := s.store.ConsumeEmailToken(r.Context(), store.TokenResetPassword, auth.HashToken(req.Token))
	if err != nil {
		if errors.Is(err, store.ErrTokenInvalid) {
			writeError(w, http.StatusUnprocessableEntity, "invalid_token", "重置链接无效或已过期，请重新申请")
			return
		}
		s.logger.Error("consume reset token", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		if writePasswordBusy(w, err) {
			return
		}
		s.logger.Error("hash password", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if err := s.store.UpdatePasswordAndRevokeSessions(r.Context(), userID, hash); err != nil {
		s.logger.Error("update password and revoke sessions", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	s.audit(r.Context(), nil, &userID, "account.password_reset", nil)

	if s.settings.Get().SMTPConfigured() {
		if user, lookupErr := s.store.UserByID(r.Context(), userID); lookupErr == nil {
			if sendErr := s.mailer.Send(r.Context(), mail.PasswordChangedMessage(user.Email)); sendErr != nil {
				s.logger.Error("send password changed mail", "error", sendErr)
			}
		}
	}

	s.clearSessionCookies(w)
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) sendVerification(ctx context.Context, user store.User, base *url.URL) error {
	raw, hash, err := auth.NewToken()
	if err != nil {
		return err
	}
	if err := s.store.CreateEmailToken(ctx, user.ID, store.TokenVerifyEmail, hash, s.now().Add(verifyTokenTTL)); err != nil {
		return err
	}
	return s.mailer.Send(ctx, mail.VerificationMessage(base, user.Email, raw))
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	current, _ := sessionFrom(r.Context())

	sessions, err := s.store.ListSessions(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("list sessions", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	out := make([]sessionDTO, 0, len(sessions))
	for _, info := range sessions {
		out = append(out, sessionDTO{
			ID:            info.ID.String(),
			CreatedAt:     info.CreatedAt,
			LastSeenAt:    info.LastSeenAt,
			LastRenewedAt: info.LastRenewedAt,
			ExpiresAt:     info.ExpiresAt,
			UserAgent:     info.UserAgent,
			IP:            info.IP,
			Current:       info.ID == current.ID,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

func (s *Server) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_id", "会话标识无效")
		return
	}
	if err := s.store.DeleteSessionForUser(r.Context(), id, user.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// The device list can be slightly stale, and DELETE is naturally
			// idempotent: the desired end state is already true.
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
			return
		}
		s.logger.Error("delete session", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) handleLogoutAll(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	current, _ := sessionFrom(r.Context())
	if err := s.store.DeleteSessions(r.Context(), user.ID, current.ID); err != nil {
		s.logger.Error("delete sessions", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}
