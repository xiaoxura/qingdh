package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Secret is one encrypted blob per (user, kind). Payload is always a client
// encrypted envelope; the store never inspects it.
type Secret struct {
	UserID    uuid.UUID
	Kind      string
	Payload   json.RawMessage
	Revision  int64
	UpdatedAt time.Time
}

// GetSecret returns the encrypted secret for the given kind. A missing row is
// reported as ErrNotFound; callers treat that as revision 0.
func (s *Store) GetSecret(ctx context.Context, userID uuid.UUID, kind string) (Secret, error) {
	var secret Secret
	err := s.pool.QueryRow(ctx, `
		SELECT user_id, kind, payload, revision, updated_at
		FROM user_secrets WHERE user_id = $1 AND kind = $2`, userID, kind).
		Scan(&secret.UserID, &secret.Kind, &secret.Payload, &secret.Revision, &secret.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Secret{}, ErrNotFound
	}
	if err != nil {
		return Secret{}, err
	}
	return secret, nil
}

// PutSecret writes payload when the stored revision still equals baseRevision.
// Creating the row requires baseRevision 0. It returns ErrConflict otherwise.
func (s *Store) PutSecret(ctx context.Context, userID uuid.UUID, kind string, baseRevision int64, payload []byte) (Secret, error) {
	var secret Secret

	err := s.pool.QueryRow(ctx, `
		UPDATE user_secrets
		SET payload = $3::jsonb, revision = revision + 1, updated_at = now()
		WHERE user_id = $1 AND kind = $2 AND revision = $4
		RETURNING user_id, kind, payload, revision, updated_at`,
		userID, kind, payload, baseRevision).
		Scan(&secret.UserID, &secret.Kind, &secret.Payload, &secret.Revision, &secret.UpdatedAt)
	if err == nil {
		return secret, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Secret{}, err
	}
	if baseRevision != 0 {
		return Secret{}, ErrConflict
	}

	// No row was updated: either the secret does not exist yet (create) or the
	// caller's base revision is stale. INSERT ... ON CONFLICT DO NOTHING keeps
	// concurrent creates safe.
	err = s.pool.QueryRow(ctx, `
		INSERT INTO user_secrets (user_id, kind, payload, revision, updated_at)
		VALUES ($1, $2, $3::jsonb, 1, now())
		ON CONFLICT (user_id, kind) DO NOTHING
		RETURNING user_id, kind, payload, revision, updated_at`,
		userID, kind, payload).
		Scan(&secret.UserID, &secret.Kind, &secret.Payload, &secret.Revision, &secret.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Secret{}, ErrConflict
	}
	if err != nil {
		return Secret{}, err
	}
	return secret, nil
}
