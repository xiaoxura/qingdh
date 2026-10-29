package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// AuditEntry is one privileged or destructive action.
type AuditEntry struct {
	ID        int64           `json:"id"`
	ActorID   *uuid.UUID      `json:"actorId,omitempty"`
	TargetID  *uuid.UUID      `json:"targetId,omitempty"`
	Action    string          `json:"action"`
	Detail    json.RawMessage `json:"detail"`
	CreatedAt time.Time       `json:"createdAt"`
}

// RecordAudit appends an audit row. actor/target may be nil for system actions.
func (s *Store) RecordAudit(ctx context.Context, actorID, targetID *uuid.UUID, action string, detail []byte) error {
	if len(detail) == 0 {
		detail = []byte(`{}`)
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO audit_log (actor_id, target_id, action, detail)
		VALUES ($1, $2, $3, $4::jsonb)`, actorID, targetID, action, detail)
	return err
}

// ListAudit returns the newest audit entries, optionally filtered by actor.
func (s *Store) ListAudit(ctx context.Context, actorID *uuid.UUID, limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, actor_id, target_id, action, detail, created_at
		FROM audit_log
		WHERE ($1::uuid IS NULL OR actor_id = $1)
		ORDER BY created_at DESC
		LIMIT $2`, actorID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]AuditEntry, 0, limit)
	for rows.Next() {
		var entry AuditEntry
		if err := rows.Scan(&entry.ID, &entry.ActorID, &entry.TargetID, &entry.Action, &entry.Detail, &entry.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}

// DeleteOldAudit prunes audit rows older than the retention window.
func (s *Store) DeleteOldAudit(ctx context.Context, olderThan time.Duration) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM audit_log WHERE created_at < $1`, time.Now().Add(-olderThan))
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
