package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DocumentRevision is a stored snapshot of one successful workspace write.
// The newest revision is also the current document.
type DocumentRevision struct {
	Revision  int64
	Payload   json.RawMessage
	Size      int64
	CreatedAt time.Time
}

// RevisionInfo is the metadata-only form used by the history list.
type RevisionInfo struct {
	Revision  int64
	Size      int64
	CreatedAt time.Time
}

// ListDocumentRevisions returns the retained history of one user, newest
// first. It is scoped by user_id so one account can never read another's.
func (s *Store) ListDocumentRevisions(ctx context.Context, userID uuid.UUID, limit int) ([]RevisionInfo, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := s.pool.Query(ctx, `
		SELECT revision, octet_length(payload::text), created_at
		FROM document_revisions
		WHERE user_id = $1
		ORDER BY revision DESC
		LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]RevisionInfo, 0, limit)
	for rows.Next() {
		var info RevisionInfo
		if err := rows.Scan(&info.Revision, &info.Size, &info.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, info)
	}
	return out, rows.Err()
}

// GetDocumentRevision loads one snapshot owned by the user.
func (s *Store) GetDocumentRevision(ctx context.Context, userID uuid.UUID, revision int64) (DocumentRevision, error) {
	var item DocumentRevision
	err := s.pool.QueryRow(ctx, `
		SELECT revision, payload, octet_length(payload::text), created_at
		FROM document_revisions
		WHERE user_id = $1 AND revision = $2`, userID, revision).
		Scan(&item.Revision, &item.Payload, &item.Size, &item.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return DocumentRevision{}, ErrNotFound
	}
	if err != nil {
		return DocumentRevision{}, err
	}
	return item, nil
}

// PruneDocumentRevisions enforces the retention policy: at most keep newest
// snapshots per user, and nothing older than maxAge. It returns the total
// number of rows removed.
func (s *Store) PruneDocumentRevisions(ctx context.Context, keep int, maxAge time.Duration) (int64, error) {
	if keep <= 0 {
		keep = 20
	}
	var removed int64
	if maxAge > 0 {
		tag, err := s.pool.Exec(ctx, `
			DELETE FROM document_revisions
			WHERE created_at < now() - $1::interval`, maxAge)
		if err != nil {
			return removed, err
		}
		removed += tag.RowsAffected()
	}

	tag, err := s.pool.Exec(ctx, `
		DELETE FROM document_revisions r
		USING (
			SELECT id FROM (
				SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY revision DESC) AS rn
				FROM document_revisions
			) ranked
			WHERE ranked.rn > $1
		) old
		WHERE r.id = old.id`, keep)
	if err != nil {
		return removed, err
	}
	removed += tag.RowsAffected()
	return removed, nil
}
