package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/XiaoXuRa/qingdh/internal/auth"
	"github.com/XiaoXuRa/qingdh/internal/store"
)

type deleteAccountRequest struct {
	Password string `json:"password"`
}

func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}

	var req deleteAccountRequest
	if !decodeJSON(w, r, &req, maxAuthBodyBytes) {
		return
	}

	// Require the password even for sessions: deleting an account is the most
	// destructive action in the product.
	verified, err := auth.VerifyPassword(req.Password, user.PasswordHash)
	if err != nil {
		if writePasswordBusy(w, err) {
			return
		}
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	if !verified {
		writeError(w, http.StatusForbidden, "invalid_password", "密码不正确")
		return
	}

	if err := s.store.DeleteUser(r.Context(), user.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "账号不存在")
			return
		}
		s.logger.Error("delete account", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}
	// The user row is gone; keep the target id but no actor foreign key.
	s.audit(r.Context(), nil, &user.ID, "account.delete", nil)

	s.clearSessionCookies(w)
	writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
}

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}

	doc, err := s.store.GetDocument(r.Context(), user.ID)
	if err != nil {
		s.logger.Error("get document", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	filename := fmt.Sprintf("qingdh-%s.json", time.Now().Format("2006-01-02"))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(doc.Payload)
}
