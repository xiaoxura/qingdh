package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Session is a logged-in device. The raw token is never stored.
type Session struct {
	ID            uuid.UUID
	UserID        uuid.UUID
	DeviceID      string
	TokenHash     []byte
	UserAgent     string
	IP            string
	CreatedAt     time.Time
	LastSeenAt    time.Time
	LastRenewedAt time.Time
	ExpiresAt     time.Time
}

const sessionColumns = `id, user_id, device_id, token_hash, user_agent, ip, created_at, last_seen_at, last_renewed_at, expires_at`

// UpsertSession stores a session for one browser. A device that logs in again
// replaces the token of its existing session instead of creating another
// "device". Sessions created before device IDs existed are dropped on the
// first login after the upgrade, so old duplicates disappear in one go.
func (s *Store) UpsertSession(ctx context.Context, userID uuid.UUID, deviceID string, tokenHash []byte, userAgent, ip string, expiresAt time.Time) (Session, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if deviceID != "" {
		if _, err := tx.Exec(ctx, `
			DELETE FROM sessions WHERE user_id = $1 AND device_id = ''`, userID); err != nil {
			return Session{}, err
		}
	}

	var sess Session
	err = scanSession(tx.QueryRow(ctx, `
		INSERT INTO sessions (user_id, device_id, token_hash, user_agent, ip, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id, device_id) WHERE device_id <> ''
		DO UPDATE SET token_hash = EXCLUDED.token_hash,
		              user_agent = EXCLUDED.user_agent,
		              ip = EXCLUDED.ip,
		              last_seen_at = now(),
		              last_renewed_at = now(),
		              expires_at = EXCLUDED.expires_at
		RETURNING `+sessionColumns,
		userID, deviceID, tokenHash, userAgent, ip, expiresAt), &sess)
	if err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return sess, nil
}

// SessionByTokenHash returns a live session and its user.
func (s *Store) SessionByTokenHash(ctx context.Context, tokenHash []byte) (Session, User, error) {
	var sess Session
	var user User
	row := s.pool.QueryRow(ctx, `
		SELECT s.id, s.user_id, s.device_id, s.token_hash, s.user_agent, s.ip, s.created_at,
		       s.last_seen_at, s.last_renewed_at, s.expires_at,
		       u.id, u.email, u.password_hash, u.email_verified_at,
		       u.is_admin, u.disabled_at, u.created_at, u.updated_at
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.expires_at > now()`, tokenHash)
	err := row.Scan(
		&sess.ID, &sess.UserID, &sess.DeviceID, &sess.TokenHash, &sess.UserAgent, &sess.IP,
		&sess.CreatedAt, &sess.LastSeenAt, &sess.LastRenewedAt, &sess.ExpiresAt,
		&user.ID, &user.Email, &user.PasswordHash, &user.EmailVerifiedAt,
		&user.IsAdmin, &user.DisabledAt, &user.CreatedAt, &user.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, User{}, ErrNotFound
	}
	if err != nil {
		return Session{}, User{}, err
	}
	return sess, user, nil
}

// RenewSession extends a session using a sliding idle window bounded by the
// absolute lifetime. It is a no-op when the session was renewed recently, so
// that reads do not cause a write per request.
//
// It returns the new expiry, or nil when nothing changed.
func (s *Store) RenewSession(ctx context.Context, id uuid.UUID, idleTTL, absoluteTTL, renewAfter time.Duration) (*time.Time, error) {
	var expiresAt time.Time
	err := s.pool.QueryRow(ctx, `
		UPDATE sessions
		SET expires_at = LEAST(now() + $2::interval, created_at + $3::interval),
		    last_renewed_at = now(),
		    last_seen_at = now()
		WHERE id = $1
		  AND expires_at > now()
		  AND created_at + $3::interval > now()
		  AND last_renewed_at < now() - $4::interval
		RETURNING expires_at`,
		id, idleTTL, absoluteTTL, renewAfter).Scan(&expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &expiresAt, nil
}

// SessionByID loads a session regardless of expiry. Used by diagnostics and
// tests.
func (s *Store) SessionByID(ctx context.Context, id uuid.UUID) (Session, error) {
	var sess Session
	if err := scanSession(s.pool.QueryRow(ctx, `SELECT `+sessionColumns+` FROM sessions WHERE id = $1`, id), &sess); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Session{}, ErrNotFound
		}
		return Session{}, err
	}
	return sess, nil
}

// LatestSessionForEmail returns the newest session of an account.
func (s *Store) LatestSessionForEmail(ctx context.Context, email string) (Session, error) {
	var sess Session
	err := scanSession(s.pool.QueryRow(ctx, `
		SELECT `+sessionColumns+`
		FROM sessions
		WHERE user_id = (SELECT id FROM users WHERE email = $1)
		ORDER BY created_at DESC
		LIMIT 1`, email), &sess)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	return sess, err
}

// SetSessionTimes rewinds a session's created/renewed timestamps. It exists so
// operators can recover from clock drift and so tests can simulate ageing.
func (s *Store) SetSessionTimes(ctx context.Context, id uuid.UUID, createdAt, renewedAt time.Time) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE sessions SET created_at = $2, last_renewed_at = $3, last_seen_at = $3
		WHERE id = $1`, id, createdAt, renewedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteSessionForUser removes one session owned by the user.
func (s *Store) DeleteSessionForUser(ctx context.Context, id, userID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteSession removes one session.
func (s *Store) DeleteSession(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id)
	return err
}

// DeleteSessions removes every session of a user except keepID (zero value
// means delete all).
func (s *Store) DeleteSessions(ctx context.Context, userID, keepID uuid.UUID) error {
	if keepID == uuid.Nil {
		_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, userID, keepID)
	return err
}

// DeleteExpiredSessions prunes sessions past their expiry.
func (s *Store) DeleteExpiredSessions(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at < now()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// SessionInfo is the sanitized view of a session returned to clients.
type SessionInfo struct {
	ID            uuid.UUID
	UserAgent     string
	IP            string
	CreatedAt     time.Time
	LastSeenAt    time.Time
	LastRenewedAt time.Time
	ExpiresAt     time.Time
}

// ListSessions returns the active sessions of a user, newest first.
func (s *Store) ListSessions(ctx context.Context, userID uuid.UUID) ([]SessionInfo, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, user_agent, ip, created_at, last_seen_at, last_renewed_at, expires_at
		FROM sessions
		WHERE user_id = $1 AND expires_at > now()
		ORDER BY last_seen_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SessionInfo
	for rows.Next() {
		var info SessionInfo
		if err := rows.Scan(&info.ID, &info.UserAgent, &info.IP, &info.CreatedAt, &info.LastSeenAt, &info.LastRenewedAt, &info.ExpiresAt); err != nil {
			return nil, err
		}
		out = append(out, info)
	}
	return out, rows.Err()
}

func scanSession(row pgx.Row, sess *Session) error {
	return row.Scan(&sess.ID, &sess.UserID, &sess.DeviceID, &sess.TokenHash, &sess.UserAgent, &sess.IP,
		&sess.CreatedAt, &sess.LastSeenAt, &sess.LastRenewedAt, &sess.ExpiresAt)
}
