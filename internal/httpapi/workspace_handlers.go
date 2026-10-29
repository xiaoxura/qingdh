package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/XiaoXuRa/qingdh/internal/auth"
	"github.com/XiaoXuRa/qingdh/internal/docval"
	"github.com/XiaoXuRa/qingdh/internal/store"
)

func (s *Server) handleGetWorkspace(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}

	doc, err := s.store.GetDocument(r.Context(), user.ID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// Should not happen: registration creates the document.
			etag := workspaceETag(0)
			w.Header().Set("ETag", etag)
			if etagMatches(r.Header.Get("If-None-Match"), etag) {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			writeJSON(w, http.StatusOK, workspaceDTO{
				Revision:  0,
				Payload:   json.RawMessage(`{"version":2,"settings":{},"groups":[]}`),
				UpdatedAt: s.now(),
			})
			return
		}
		s.logger.Error("get workspace", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	etag := workspaceETag(doc.Revision)
	w.Header().Set("ETag", etag)
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	writeJSON(w, http.StatusOK, workspaceDTO{
		Revision:  doc.Revision,
		Payload:   json.RawMessage(doc.Payload),
		UpdatedAt: doc.UpdatedAt,
	})
}

type putWorkspaceRequest struct {
	BaseRevision int64           `json:"baseRevision"`
	Payload      json.RawMessage `json:"payload"`
}

func (s *Server) handlePutWorkspace(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}

	var req putWorkspaceRequest
	if !decodeJSON(w, r, &req, int64(maxDocumentBytes)+(64<<10)) {
		return
	}
	if req.BaseRevision < 0 {
		writeError(w, http.StatusUnprocessableEntity, "invalid_payload", "baseRevision 不能为负数")
		return
	}

	payload, err := docval.Validate(req.Payload, maxDocumentBytes)
	if err != nil {
		var verr *docval.Error
		if errors.As(err, &verr) {
			status := http.StatusUnprocessableEntity
			if verr.Code == "payload_too_large" {
				status = http.StatusRequestEntityTooLarge
			}
			writeError(w, status, verr.Code, verr.Message)
			return
		}
		s.logger.Error("validate payload", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	if current, err := s.store.GetDocument(r.Context(), user.ID); err == nil {
		if payloadVersion(current.Payload) == docval.EncryptedVersion && payloadVersion(payload) != docval.EncryptedVersion {
			writeError(w, http.StatusUnprocessableEntity, "encryption_required", "云端数据已加密，无法用明文覆盖，请解锁后上传")
			return
		}
	} else if !errors.Is(err, store.ErrNotFound) {
		s.logger.Error("read current document", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	doc, err := s.store.UpdateDocument(r.Context(), user.ID, req.BaseRevision, payload)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			s.writeConflict(w, r, user)
			return
		}
		s.logger.Error("update workspace", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"revision":  doc.Revision,
		"updatedAt": doc.UpdatedAt,
	})
}

type disableEncryptionRequest struct {
	BaseRevision    int64           `json:"baseRevision"`
	CurrentPassword string          `json:"currentPassword"`
	Payload         json.RawMessage `json:"payload"`
}

// handleDisableEncryption is the explicit, password-confirmed exit from v3
// encryption. It deliberately does not relax PUT /workspace: the downgrade
// guard there keeps rejecting plaintext uploads on encrypted documents.
func (s *Server) handleDisableEncryption(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	if !s.limiter.allow("disable-encryption:"+user.ID.String(), limitDisableEncPerUser, burstDisableEncPerUser) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "操作过于频繁，请稍后再试")
		return
	}

	var req disableEncryptionRequest
	if !decodeJSON(w, r, &req, int64(maxDocumentBytes)+(64<<10)) {
		return
	}
	if req.BaseRevision < 0 {
		writeError(w, http.StatusUnprocessableEntity, "invalid_payload", "baseRevision 不能为负数")
		return
	}

	current, err := s.store.GetDocument(r.Context(), user.ID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnprocessableEntity, "not_encrypted", "当前云端数据未加密")
			return
		}
		s.logger.Error("read current document", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if payloadVersion(current.Payload) != docval.EncryptedVersion {
		writeError(w, http.StatusUnprocessableEntity, "not_encrypted", "当前云端数据未加密")
		return
	}

	verified, err := auth.VerifyPassword(req.CurrentPassword, user.PasswordHash)
	if err != nil {
		if writePasswordBusy(w, err) {
			return
		}
		s.logger.Error("verify password for disable encryption", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if !verified {
		writeError(w, http.StatusForbidden, "invalid_password", "登录密码不正确")
		return
	}

	payload, err := docval.Validate(req.Payload, maxDocumentBytes)
	if err != nil {
		var verr *docval.Error
		if errors.As(err, &verr) {
			status := http.StatusUnprocessableEntity
			if verr.Code == "payload_too_large" {
				status = http.StatusRequestEntityTooLarge
			}
			writeError(w, status, verr.Code, verr.Message)
			return
		}
		s.logger.Error("validate plaintext payload", "error", err)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if payloadVersion(payload) != docval.SupportedVersion {
		writeError(w, http.StatusUnprocessableEntity, "invalid_payload", "关闭加密只能提交明文 v2 文档")
		return
	}

	if current.Revision != req.BaseRevision {
		s.writeConflict(w, r, user)
		return
	}

	// AI 配置和备忘录使用主 dataKey 派生的子密钥。关闭加密后 dataKey 不再
	// 可用，必须在这之前由用户导出或删除；隐私空间使用独立密钥，可以保留。
	kinds, err := s.store.SecretKinds(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("list secret kinds", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	blocking := make([]string, 0, 2)
	for _, kind := range kinds {
		if kind == "ai" || kind == "memo" {
			blocking = append(blocking, kind)
		}
	}
	if len(blocking) > 0 {
		writeErrorWith(w, http.StatusConflict, "encryption_dependency",
			"AI 配置或备忘录仍使用主数据密钥加密，关闭后将无法解密；请先导出或删除这些数据",
			map[string]any{"secrets": blocking})
		return
	}

	doc, err := s.store.UpdateDocument(r.Context(), user.ID, req.BaseRevision, payload)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			s.writeConflict(w, r, user)
			return
		}
		s.logger.Error("disable encryption", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	s.audit(r.Context(), &user.ID, &user.ID, "account.encryption_disabled", map[string]any{"revision": doc.Revision})

	writeJSON(w, http.StatusOK, map[string]any{
		"revision":  doc.Revision,
		"updatedAt": doc.UpdatedAt,
	})
}

func workspaceETag(revision int64) string {
	return fmt.Sprintf(`"w-%d"`, revision)
}

func payloadVersion(raw json.RawMessage) int {
	var header struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		return 0
	}
	return header.Version
}

// writeConflict returns 409 together with the current server document so the
// client can merge without an extra round trip.
func (s *Server) writeConflict(w http.ResponseWriter, r *http.Request, user store.User) {
	doc, err := s.store.GetDocument(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("read document after conflict", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusConflict, "revision_conflict", "云端数据已更新，请重新同步")
		return
	}

	writeErrorWith(w, http.StatusConflict, "revision_conflict", "云端数据已更新", map[string]any{
		"current": map[string]any{
			"revision":  doc.Revision,
			"payload":   json.RawMessage(doc.Payload),
			"updatedAt": doc.UpdatedAt,
		},
	})
}
