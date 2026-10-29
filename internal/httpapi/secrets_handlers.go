package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/XiaoXuRa/qingdh/internal/docval"
	"github.com/XiaoXuRa/qingdh/internal/store"
)

// secretDTO is the wire format of an encrypted secret. Payload is always a v4
// client envelope; the server never decrypts it.
type secretDTO struct {
	Revision  int64           `json:"revision"`
	Payload   json.RawMessage `json:"payload"`
	UpdatedAt *time.Time      `json:"updatedAt"`
}

func (s *Server) handleGetSecret(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}

	kind := r.PathValue("kind")
	if !docval.SecretKindAllowed(kind) {
		writeError(w, http.StatusNotFound, "not_found", "不支持的 secret 类型")
		return
	}

	secret, err := s.store.GetSecret(r.Context(), user.ID, kind)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusOK, secretDTO{Revision: 0})
			return
		}
		s.logger.Error("get secret", "error", err, "user_id", user.ID.String(), "kind", kind)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	updatedAt := secret.UpdatedAt
	writeJSON(w, http.StatusOK, secretDTO{
		Revision:  secret.Revision,
		Payload:   json.RawMessage(secret.Payload),
		UpdatedAt: &updatedAt,
	})
}

type putSecretRequest struct {
	BaseRevision int64           `json:"baseRevision"`
	Payload      json.RawMessage `json:"payload"`
}

func (s *Server) handlePutSecret(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}

	kind := r.PathValue("kind")
	if !docval.SecretKindAllowed(kind) {
		writeError(w, http.StatusNotFound, "not_found", "不支持的 secret 类型")
		return
	}
	if !s.limiter.allow("secret:"+user.ID.String(), limitSecretPerUser, burstSecretPerUser) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "保存太频繁，请稍后再试")
		return
	}

	maxBytes := docval.MaxSecretBytesForKind(kind)
	var req putSecretRequest
	if !decodeJSON(w, r, &req, int64(maxBytes)+(64<<10)) {
		return
	}
	if req.BaseRevision < 0 {
		writeError(w, http.StatusUnprocessableEntity, "invalid_payload", "baseRevision 不能为负数")
		return
	}

	payload, err := docval.ValidateSecret(kind, req.Payload, maxBytes)
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
		s.logger.Error("validate secret", "error", err, "kind", kind)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	secret, err := s.store.PutSecret(r.Context(), user.ID, kind, req.BaseRevision, payload)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			s.writeSecretConflict(w, r, user.ID, kind)
			return
		}
		s.logger.Error("put secret", "error", err, "user_id", user.ID.String(), "kind", kind)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"revision":  secret.Revision,
		"updatedAt": secret.UpdatedAt,
	})
}

// writeSecretConflict returns 409 together with the current ciphertext so the
// client can re-merge without another round trip.
func (s *Server) writeSecretConflict(w http.ResponseWriter, r *http.Request, userID uuid.UUID, kind string) {
	current := map[string]any{"revision": int64(0)}
	if secret, err := s.store.GetSecret(r.Context(), userID, kind); err == nil {
		current["revision"] = secret.Revision
		current["payload"] = json.RawMessage(secret.Payload)
		current["updatedAt"] = secret.UpdatedAt
	}

	writeErrorWith(w, http.StatusConflict, "revision_conflict", "云端配置已更新", map[string]any{
		"current": current,
	})
}
