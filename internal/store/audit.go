package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// AuditEntry is one privileged or destructive action.
type AuditEntry struct {
	ID         int64           `json:"id"`
	ActorID    *uuid.UUID      `json:"actorId,omitempty"`
	ActorEmail string          `json:"actorEmail"`
	TargetID   *uuid.UUID      `json:"targetId,omitempty"`
	Action     string          `json:"action"`
	Detail     json.RawMessage `json:"detail"`
	CreatedAt  time.Time       `json:"createdAt"`
}

// AuditFilter selects a page of audit rows. Empty strings mean "no filter".
type AuditFilter struct {
	ActorID    *uuid.UUID
	ActorEmail string
	Action     string
	Limit      int
	Offset     int
}

// RecordAudit appends an audit row. actor/target may be nil for system actions.
// actorEmail is a snapshot so the trail survives deletion of the account.
func (s *Store) RecordAudit(ctx context.Context, actorID *uuid.UUID, actorEmail string, targetID *uuid.UUID, action string, detail []byte) error {
	if len(detail) == 0 {
		detail = []byte(`{}`)
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO audit_log (actor_id, actor_email, target_id, action, detail)
		VALUES ($1, $2, $3, $4, $5::jsonb)`, actorID, actorEmail, targetID, action, detail)
	return err
}

// ListAudit returns the newest audit entries, optionally filtered by actor.
// It is kept for existing callers/tests; the HTTP admin endpoint uses
// ListAuditPage so it can also filter by action and return a total.
func (s *Store) ListAudit(ctx context.Context, actorID *uuid.UUID, limit int) ([]AuditEntry, error) {
	entries, _, err := s.ListAuditPage(ctx, AuditFilter{ActorID: actorID, Limit: limit})
	return entries, err
}

// ListAuditPage returns one page plus the total number of matching rows.
func (s *Store) ListAuditPage(ctx context.Context, filter AuditFilter) ([]AuditEntry, int, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}

	rows, err := s.pool.Query(ctx, `
		SELECT id, actor_id, actor_email, target_id, action, detail, created_at,
		       count(*) OVER()::int AS total
		FROM audit_log
		WHERE ($1::uuid IS NULL OR actor_id = $1)
		  AND ($2 = '' OR actor_email ILIKE '%' || $2 || '%')
		  AND ($3 = '' OR action = $3)
		ORDER BY created_at DESC, id DESC
		LIMIT $4 OFFSET $5`,
		filter.ActorID, filter.ActorEmail, filter.Action, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	entries := make([]AuditEntry, 0, limit)
	total := 0
	for rows.Next() {
		var entry AuditEntry
		if err := rows.Scan(&entry.ID, &entry.ActorID, &entry.ActorEmail, &entry.TargetID,
			&entry.Action, &entry.Detail, &entry.CreatedAt, &total); err != nil {
			return nil, 0, err
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return entries, total, nil
}

// DeleteOldAudit prunes audit rows older than the retention window.
func (s *Store) DeleteOldAudit(ctx context.Context, olderThan time.Duration) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM audit_log WHERE created_at < $1`, time.Now().Add(-olderThan))
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
