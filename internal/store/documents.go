package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Document is one user's navigation data.
type Document struct {
	UserID    uuid.UUID
	Payload   json.RawMessage
	Revision  int64
	UpdatedAt time.Time
}

// GetDocument returns the user's document. A user created by CreateUser always
// has one, so a missing row is treated as not found.
func (s *Store) GetDocument(ctx context.Context, userID uuid.UUID) (Document, error) {
	var doc Document
	err := s.pool.QueryRow(ctx, `
		SELECT user_id, payload, revision, updated_at
		FROM documents WHERE user_id = $1`, userID).
		Scan(&doc.UserID, &doc.Payload, &doc.Revision, &doc.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrNotFound
	}
	if err != nil {
		return Document{}, err
	}
	return doc, nil
}

// UpdateDocument writes payload when the stored revision still equals
// baseRevision. It returns ErrConflict otherwise.
//
// 文档行缺失（例如旧数据或手工清理）时按 revision 0 自愈，与 PutSecret 的
// 行为保持一致；否则客户端会永久 409 且无法从 GET 的 fallback 中恢复。
func (s *Store) UpdateDocument(ctx context.Context, userID uuid.UUID, baseRevision int64, payload []byte) (Document, error) {
	var doc Document
	err := s.pool.QueryRow(ctx, `
		UPDATE documents
		SET payload = $3::jsonb, revision = revision + 1, updated_at = now()
		WHERE user_id = $1 AND revision = $2
		RETURNING user_id, payload, revision, updated_at`,
		userID, baseRevision, payload).
		Scan(&doc.UserID, &doc.Payload, &doc.Revision, &doc.UpdatedAt)
	if err == nil {
		return doc, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Document{}, err
	}
	if baseRevision != 0 {
		return Document{}, ErrConflict
	}

	// 行不存在时以 revision 1 插入；并发插入由 ON CONFLICT 收敛，另一个
	// 请求随后会得到 ErrConflict。
	err = s.pool.QueryRow(ctx, `
		INSERT INTO documents (user_id, payload, revision, updated_at)
		VALUES ($1, $2::jsonb, 1, now())
		ON CONFLICT (user_id) DO NOTHING
		RETURNING user_id, payload, revision, updated_at`,
		userID, payload).
		Scan(&doc.UserID, &doc.Payload, &doc.Revision, &doc.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Document{}, ErrConflict
	}
	if err != nil {
		return Document{}, err
	}
	return doc, nil
}
