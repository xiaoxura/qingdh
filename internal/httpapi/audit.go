package httpapi

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// audit records a privileged action without letting an audit failure block the
// action itself. Detail must never contain passwords, tokens or user content.
func (s *Server) audit(ctx context.Context, actorID, targetID *uuid.UUID, action string, detail map[string]any) {
	if s.store == nil {
		return
	}
	payload := []byte(`{}`)
	if detail != nil {
		if raw, err := json.Marshal(detail); err == nil {
			payload = raw
		}
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	if err := s.store.RecordAudit(ctx, actorID, targetID, action, payload); err != nil {
		s.logger.Warn("record audit", "error", err, "action", action)
	}
}
