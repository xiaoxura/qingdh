package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Email token kinds.
const (
	TokenVerifyEmail   = "verify_email"
	TokenResetPassword = "reset_password"
)

// CreateEmailToken stores a hashed single-use token, invalidating older
// unused tokens of the same kind for that user.
func (s *Store) CreateEmailToken(ctx context.Context, userID uuid.UUID, kind string, tokenHash []byte, expiresAt time.Time) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			DELETE FROM email_tokens
			WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`, userID, kind); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO email_tokens (user_id, kind, token_hash, expires_at)
			VALUES ($1, $2, $3, $4)`, userID, kind, tokenHash, expiresAt)
		return err
	})
}

// ConsumeEmailToken marks a token as used and returns its owner. It fails with
// ErrTokenInvalid when the token is unknown, expired, already used or of the
// wrong kind.
func (s *Store) ConsumeEmailToken(ctx context.Context, kind string, tokenHash []byte) (uuid.UUID, error) {
	var userID uuid.UUID
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			UPDATE email_tokens
			SET used_at = now()
			WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now()
			RETURNING user_id`, tokenHash, kind).Scan(&userID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTokenInvalid
		}
		return err
	})
	if err != nil {
		return uuid.Nil, err
	}
	return userID, nil
}

// DeleteExpiredTokens prunes stale tokens.
func (s *Store) DeleteExpiredTokens(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM email_tokens
		WHERE expires_at < now() - interval '7 days'`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
