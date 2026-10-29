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
// 每次成功写入都在同一事务里追加一条 document_revisions 历史；历史写入失败
// 会回滚文档更新，因此“成功的 PUT 必有历史”是强约束。文档行缺失（例如旧
// 数据或手工清理）时按 revision 0 自愈，与 PutSecret 的行为保持一致。
func (s *Store) UpdateDocument(ctx context.Context, userID uuid.UUID, baseRevision int64, payload []byte) (Document, error) {
	var doc Document

	err := s.withTx(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			UPDATE documents
			SET payload = $3::jsonb, revision = revision + 1, updated_at = now()
			WHERE user_id = $1 AND revision = $2
			RETURNING user_id, payload, revision, updated_at`,
			userID, baseRevision, payload).
			Scan(&doc.UserID, &doc.Payload, &doc.Revision, &doc.UpdatedAt)
		if err == nil {
			return recordDocumentRevision(ctx, tx, userID, doc.Revision, payload)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if baseRevision != 0 {
			return ErrConflict
		}

		// 行不存在时以 revision 1 插入；并发插入由 ON CONFLICT 收敛。
		err = tx.QueryRow(ctx, `
			INSERT INTO documents (user_id, payload, revision, updated_at)
			VALUES ($1, $2::jsonb, 1, now())
			ON CONFLICT (user_id) DO NOTHING
			RETURNING user_id, payload, revision, updated_at`,
			userID, payload).
			Scan(&doc.UserID, &doc.Payload, &doc.Revision, &doc.UpdatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrConflict
		}
		if err != nil {
			return err
		}
		return recordDocumentRevision(ctx, tx, userID, doc.Revision, payload)
	})
	if err != nil {
		return Document{}, err
	}
	return doc, nil
}

func recordDocumentRevision(ctx context.Context, tx pgx.Tx, userID uuid.UUID, revision int64, payload []byte) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO document_revisions (user_id, revision, payload)
		VALUES ($1, $2, $3::jsonb)
		ON CONFLICT (user_id, revision) DO NOTHING`, userID, revision, payload)
	return err
}
