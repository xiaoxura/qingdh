package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/XiaoXuRa/qingdh/internal/store"
)

type revisionInfoDTO struct {
	Revision  int64     `json:"revision"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"createdAt"`
}

type revisionDTO struct {
	Revision  int64           `json:"revision"`
	Payload   json.RawMessage `json:"payload"`
	Size      int64           `json:"size"`
	CreatedAt time.Time       `json:"createdAt"`
}

// handleListWorkspaceRevisions returns the retained history of the signed-in
// user. There is deliberately no administrator variant.
func (s *Server) handleListWorkspaceRevisions(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}

	revisions, err := s.store.ListDocumentRevisions(r.Context(), user.ID, 20)
	if err != nil {
		s.logger.Error("list document revisions", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	out := make([]revisionInfoDTO, 0, len(revisions))
	for _, item := range revisions {
		out = append(out, revisionInfoDTO{
			Revision:  item.Revision,
			Size:      item.Size,
			CreatedAt: item.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"revisions": out})
}

func (s *Server) handleGetWorkspaceRevision(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}

	revision, err := strconv.ParseInt(r.PathValue("revision"), 10, 64)
	if err != nil || revision < 0 {
		writeError(w, http.StatusBadRequest, "invalid_revision", "版本号无效")
		return
	}

	item, err := s.store.GetDocumentRevision(r.Context(), user.ID, revision)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "这个历史版本不存在或已被清理")
			return
		}
		s.logger.Error("get document revision", "error", err, "user_id", user.ID.String(), "revision", revision)
		writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
		return
	}

	writeJSON(w, http.StatusOK, revisionDTO{
		Revision:  item.Revision,
		Payload:   item.Payload,
		Size:      item.Size,
		CreatedAt: item.CreatedAt,
	})
}
