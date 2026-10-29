package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

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
