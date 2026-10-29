package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/XiaoXuRa/qingdh/internal/auth"
	"github.com/XiaoXuRa/qingdh/internal/mail"
	"github.com/XiaoXuRa/qingdh/internal/settings"
	"github.com/XiaoXuRa/qingdh/internal/store"
)

const (
	adminPageSizeDefault = 50
	adminPageSizeMax     = 100
)

type adminSettingsDTO struct {
	SiteName                 string `json:"siteName"`
	SiteLogo                 string `json:"siteLogo"`
	BaseURL                  string `json:"baseUrl"`
	AllowRegistration        bool   `json:"allowRegistration"`
	RequireEmailVerification bool   `json:"requireEmailVerification"`
	SMTPHost                 string `json:"smtpHost"`
	SMTPPort                 int    `json:"smtpPort"`
	SMTPUsername             string `json:"smtpUsername"`
	SMTPPasswordSet          bool   `json:"smtpPasswordSet"`
	SMTPFrom                 string `json:"smtpFrom"`
	SMTPTLS                  string `json:"smtpTls"`
	SessionIdleSeconds       int64  `json:"sessionIdleSeconds"`
	SessionAbsoluteSeconds   int64  `json:"sessionAbsoluteSeconds"`
	SessionRenewSeconds      int64  `json:"sessionRenewSeconds"`
	AIDailyLimit             int    `json:"aiDailyLimit"`
	Version                  int64  `json:"version"`

	SMTPConfigured        bool `json:"smtpConfigured"`
	EffectiveVerification bool `json:"effectiveVerification"`
}

func toAdminSettingsDTO(v settings.Values) adminSettingsDTO {
	return adminSettingsDTO{
		SiteName:                 v.SiteName,
		SiteLogo:                 v.SiteLogo,
		BaseURL:                  v.BaseURL,
		AllowRegistration:        v.AllowRegistration,
		RequireEmailVerification: v.RequireEmailVerification,
		SMTPHost:                 v.SMTPHost,
		SMTPPort:                 v.SMTPPort,
		SMTPUsername:             v.SMTPUsername,
		SMTPPasswordSet:          v.SMTPPassword != "",
		SMTPFrom:                 v.SMTPFrom,
		SMTPTLS:                  v.SMTPTLS,
		SessionIdleSeconds:       v.SessionIdleSeconds,
		SessionAbsoluteSeconds:   v.SessionAbsoluteSeconds,
		SessionRenewSeconds:      v.SessionRenewSeconds,
		AIDailyLimit:             v.AIDailyLimit,
		Version:                  v.Version,
		SMTPConfigured:           v.SMTPConfigured(),
		EffectiveVerification:    v.VerificationRequired(),
	}
}

func (s *Server) handleAdminOverview(w http.ResponseWriter, r *http.Request) {
	overview, err := s.store.AdminOverview(r.Context())
	if err != nil {
		s.logger.Error("admin overview", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

func (s *Server) handleGetAdminSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, toAdminSettingsDTO(s.settings.Get()))
}

type adminSettingsRequest struct {
	SiteName                 *string `json:"siteName"`
	SiteLogo                 *string `json:"siteLogo"`
	BaseURL                  *string `json:"baseUrl"`
	AllowRegistration        *bool   `json:"allowRegistration"`
	RequireEmailVerification *bool   `json:"requireEmailVerification"`
	SMTPHost                 *string `json:"smtpHost"`
	SMTPPort                 *int    `json:"smtpPort"`
	SMTPUsername             *string `json:"smtpUsername"`
	SMTPPassword             *string `json:"smtpPassword"`
	ClearSMTPPassword        bool    `json:"clearSmtpPassword"`
	SMTPFrom                 *string `json:"smtpFrom"`
	SMTPTLS                  *string `json:"smtpTls"`
	SessionIdleSeconds       *int64  `json:"sessionIdleSeconds"`
	SessionAbsoluteSeconds   *int64  `json:"sessionAbsoluteSeconds"`
	SessionRenewSeconds      *int64  `json:"sessionRenewSeconds"`
	AIDailyLimit             *int    `json:"aiDailyLimit"`
	Version                  *int64  `json:"version"`
}

func (s *Server) handlePutAdminSettings(w http.ResponseWriter, r *http.Request) {
	var req adminSettingsRequest
	// Uploaded logos are data URLs; keep the general auth body limit small but
	// allow this settings endpoint enough room for a validated image.
	if !decodeJSON(w, r, &req, 512<<10) {
		return
	}

	values := s.settings.Get()
	if req.SiteName != nil {
		values.SiteName = *req.SiteName
	}
	if req.SiteLogo != nil {
		values.SiteLogo = *req.SiteLogo
	}
	if req.BaseURL != nil {
		values.BaseURL = *req.BaseURL
	}
	if req.AllowRegistration != nil {
		values.AllowRegistration = *req.AllowRegistration
	}
	if req.RequireEmailVerification != nil {
		values.RequireEmailVerification = *req.RequireEmailVerification
	}
	if req.SMTPHost != nil {
		values.SMTPHost = *req.SMTPHost
	}
	if req.SMTPPort != nil {
		values.SMTPPort = *req.SMTPPort
	}
	if req.SMTPUsername != nil {
		values.SMTPUsername = *req.SMTPUsername
	}
	if req.SMTPFrom != nil {
		values.SMTPFrom = *req.SMTPFrom
	}
	if req.SMTPTLS != nil {
		values.SMTPTLS = *req.SMTPTLS
	}
	if req.ClearSMTPPassword {
		values.SMTPPassword = ""
	} else if req.SMTPPassword != nil && *req.SMTPPassword != "" {
		values.SMTPPassword = *req.SMTPPassword
	}
	if req.SessionIdleSeconds != nil {
		values.SessionIdleSeconds = *req.SessionIdleSeconds
	}
	if req.SessionAbsoluteSeconds != nil {
		values.SessionAbsoluteSeconds = *req.SessionAbsoluteSeconds
	}
	if req.SessionRenewSeconds != nil {
		values.SessionRenewSeconds = *req.SessionRenewSeconds
	}
	if req.AIDailyLimit != nil {
		values.AIDailyLimit = *req.AIDailyLimit
	}

	base := values.Version
	if req.Version != nil {
		base = *req.Version
	}
	if err := s.settings.UpdateVersioned(r.Context(), values, base); err != nil {
		if errors.Is(err, store.ErrConflict) {
			// Refresh the local cache immediately so the admin UI's follow-up
			// GET does not keep returning the stale version.
			_ = s.settings.Reload(r.Context())
			writeError(w, http.StatusConflict, "settings_conflict", "设置已被其他管理员修改，请刷新后重试")
			return
		}
		writeError(w, http.StatusUnprocessableEntity, "invalid_settings", err.Error())
		return
	}

	if admin, ok := userFrom(r.Context()); ok {
		s.logger.Info("admin settings updated", "admin_id", admin.ID.String())
		s.audit(r.Context(), &admin.ID, nil, "admin.settings.update", map[string]any{
			"version": s.settings.Get().Version,
		})
	}
	writeJSON(w, http.StatusOK, toAdminSettingsDTO(s.settings.Get()))
}

type testEmailRequest struct {
	To string `json:"to"`
}

func (s *Server) handleTestEmail(w http.ResponseWriter, r *http.Request) {
	var req testEmailRequest
	if !decodeJSON(w, r, &req, maxAuthBodyBytes) {
		return
	}
	to, err := auth.NormalizeEmail(req.To)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "invalid_email", err.Error())
		return
	}
	values := s.settings.Get()
	if !values.SMTPConfigured() {
		writeError(w, http.StatusUnprocessableEntity, "smtp_not_configured", "请先填写并保存 SMTP 配置")
		return
	}

	now := time.Now().Format("2006-01-02 15:04:05")
	msg := mail.Message{
		To:      to,
		Subject: "氢导航 SMTP 测试",
		Text:    "这是一封来自氢导航的测试邮件，发送时间：" + now + "。\n\n如果你收到了它，说明 SMTP 配置可用。",
	}
	// The production mailer is a queue; a test email must report the real
	// SMTP result, so prefer its synchronous path when available.
	send := func(ctx context.Context, message mail.Message) error {
		if sync, ok := s.mailer.(interface {
			SendNow(context.Context, mail.Message) error
		}); ok {
			return sync.SendNow(ctx, message)
		}
		return s.mailer.Send(ctx, message)
	}
	if err := send(r.Context(), msg); err != nil {
		s.logger.Error("send test email", "error", err)
		writeError(w, http.StatusBadGateway, "email_send_failed", "邮件发送失败："+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "sent"})
}

type adminUserPatch struct {
	IsAdmin  *bool `json:"isAdmin"`
	Disabled *bool `json:"disabled"`
}

func (s *Server) handleListAdminUsers(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) > 100 {
		query = query[:100]
	}
	page := 1
	if raw := r.URL.Query().Get("page"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			page = parsed
		}
	}
	pageSize := adminPageSizeDefault
	if raw := r.URL.Query().Get("pageSize"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= adminPageSizeMax {
			pageSize = parsed
		}
	}

	users, total, err := s.store.ListUsers(r.Context(), query, pageSize, (page-1)*pageSize)
	if err != nil {
		s.logger.Error("list users", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	out := make([]adminUserDTO, 0, len(users))
	for _, user := range users {
		out = append(out, toAdminUserDTO(user))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"users":    out,
		"total":    total,
		"page":     page,
		"pageSize": pageSize,
	})
}

func (s *Server) handleUpdateAdminUser(w http.ResponseWriter, r *http.Request) {
	current, _ := userFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_id", "用户标识无效")
		return
	}

	var req adminUserPatch
	if !decodeJSON(w, r, &req, maxAuthBodyBytes) {
		return
	}
	if req.IsAdmin == nil && req.Disabled == nil {
		writeError(w, http.StatusUnprocessableEntity, "nothing_to_update", "没有需要修改的字段")
		return
	}

	target, err := s.store.UserByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "用户不存在")
			return
		}
		s.logger.Error("load user", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	if target.ID == current.ID {
		if req.IsAdmin != nil && !*req.IsAdmin {
			writeError(w, http.StatusUnprocessableEntity, "self_protection", "不能取消自己的管理员权限")
			return
		}
		if req.Disabled != nil && *req.Disabled {
			writeError(w, http.StatusUnprocessableEntity, "self_protection", "不能禁用自己")
			return
		}
	}

	if req.IsAdmin != nil {
		if err := s.store.SetUserAdmin(r.Context(), id, *req.IsAdmin); err != nil {
			s.logger.Error("set admin flag", "error", err)
			writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
			return
		}
	}
	if req.Disabled != nil {
		if err := s.store.SetUserDisabled(r.Context(), id, *req.Disabled); err != nil {
			s.logger.Error("set disabled flag", "error", err)
			writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
			return
		}
		if *req.Disabled {
			// Disabling an account should log it out everywhere.
			if err := s.store.DeleteSessions(r.Context(), id, uuid.Nil); err != nil {
				s.logger.Warn("delete sessions of disabled user", "error", err)
			}
		}
	}

	if admin, ok := userFrom(r.Context()); ok {
		detail := map[string]any{}
		if req.IsAdmin != nil {
			detail["isAdmin"] = *req.IsAdmin
		}
		if req.Disabled != nil {
			detail["disabled"] = *req.Disabled
		}
		s.audit(r.Context(), &admin.ID, &id, "admin.user.update", detail)
	}

	updated, err := s.store.UserByID(r.Context(), id)
	if err != nil {
		s.logger.Error("reload user", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	writeJSON(w, http.StatusOK, toUserDTO(updated))
}

type adminWorkspaceDTO struct {
	User      userDTO         `json:"user"`
	Payload   json.RawMessage `json:"payload"`
	Revision  int64           `json:"revision"`
	UpdatedAt *time.Time      `json:"updatedAt"`
}

// handleAdminUserWorkspace exposes one user's navigation data so administrators
// can inspect groups and links without logging in as that user.
func (s *Server) handleAdminUserWorkspace(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_id", "用户标识无效")
		return
	}

	user, err := s.store.UserByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "用户不存在")
			return
		}
		s.logger.Error("load user", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	if admin, ok := userFrom(r.Context()); ok {
		s.audit(r.Context(), &admin.ID, &id, "admin.workspace.view", nil)
	}

	doc, err := s.store.GetDocument(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusOK, adminWorkspaceDTO{User: toUserDTO(user)})
			return
		}
		s.logger.Error("get user workspace", "error", err, "user_id", id.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	writeJSON(w, http.StatusOK, adminWorkspaceDTO{
		User:      toUserDTO(user),
		Payload:   json.RawMessage(doc.Payload),
		Revision:  doc.Revision,
		UpdatedAt: &doc.UpdatedAt,
	})
}

func (s *Server) handleDeleteAdminUser(w http.ResponseWriter, r *http.Request) {
	current, _ := userFrom(r.Context())
	id, ok := parseUUID(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid_id", "用户标识无效")
		return
	}
	if id == current.ID {
		writeError(w, http.StatusUnprocessableEntity, "self_protection", "不能删除自己的账号")
		return
	}

	if err := s.store.DeleteUser(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "用户不存在")
			return
		}
		s.logger.Error("delete user", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	s.audit(r.Context(), &current.ID, &id, "admin.user.delete", nil)
	writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
}
