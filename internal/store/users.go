package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// User is an account row.
type User struct {
	ID              uuid.UUID
	Email           string
	PasswordHash    string
	EmailVerifiedAt *time.Time
	IsAdmin         bool
	DisabledAt      *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// Verified reports whether the account completed email verification.
func (u User) Verified() bool { return u.EmailVerifiedAt != nil }

const userColumns = `id, email, password_hash, email_verified_at, is_admin, disabled_at, created_at, updated_at`

// CreateUser inserts a user together with the empty navigation document in a
// single transaction. It returns ErrEmailTaken when the address is in use.
func (s *Store) CreateUser(ctx context.Context, email, passwordHash string) (User, error) {
	var user User
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx, `
			INSERT INTO users (email, password_hash)
			VALUES ($1, $2)
			RETURNING `+userColumns, email, passwordHash)
		if err := scanUser(row, &user); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `INSERT INTO documents (user_id) VALUES ($1)`, user.ID)
		return err
	})
	if err != nil {
		if isUniqueViolation(err, "users_email_key") {
			return User{}, ErrEmailTaken
		}
		return User{}, err
	}
	return user, nil
}

// UserByEmail looks up an account by its normalized email address.
func (s *Store) UserByEmail(ctx context.Context, email string) (User, error) {
	return s.scanUserRow(ctx, `SELECT `+userColumns+` FROM users WHERE email = $1`, email)
}

// UserByID looks up an account by identifier.
func (s *Store) UserByID(ctx context.Context, id uuid.UUID) (User, error) {
	return s.scanUserRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, id)
}

func (s *Store) scanUserRow(ctx context.Context, query string, args ...any) (User, error) {
	var user User
	if err := scanUser(s.pool.QueryRow(ctx, query, args...), &user); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}
	return user, nil
}

func scanUser(row pgx.Row, user *User) error {
	return row.Scan(&user.ID, &user.Email, &user.PasswordHash, &user.EmailVerifiedAt,
		&user.IsAdmin, &user.DisabledAt, &user.CreatedAt, &user.UpdatedAt)
}

// MarkEmailVerified stamps users.email_verified_at once.
func (s *Store) MarkEmailVerified(ctx context.Context, id uuid.UUID, at time.Time) (User, error) {
	return s.scanUserRow(ctx, `
		UPDATE users
		SET email_verified_at = COALESCE(email_verified_at, $2), updated_at = now()
		WHERE id = $1
		RETURNING `+userColumns, id, at)
}

// UpdatePassword replaces the password hash and bumps updated_at.
func (s *Store) UpdatePassword(ctx context.Context, id uuid.UUID, hash string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, id, hash)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdatePasswordAndRevokeSessions updates the password hash and removes every
// session in one transaction. A failed revocation therefore cannot leave old
// sessions valid after a password reset.
func (s *Store) UpdatePasswordAndRevokeSessions(ctx context.Context, id uuid.UUID, hash string) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, id, hash)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		_, err = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
		return err
	})
}

// DeleteUser removes the account; sessions, tokens and the document cascade.
func (s *Store) DeleteUser(ctx context.Context, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// AdminUser is a user plus counts of cloud-stored data. The counts are derived
// from the navigation document and encrypted secret rows; no content is read.
type AdminUser struct {
	User
	CloudLinks   int
	CloudGroups  int
	CloudSecrets int
}

// ListUsers returns a page of accounts matching an optional email search.
func (s *Store) ListUsers(ctx context.Context, search string, limit, offset int) ([]AdminUser, int, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}

	var total int
	rows, err := s.pool.Query(ctx, `
		SELECT u.id, u.email, u.password_hash, u.email_verified_at,
		       u.is_admin, u.disabled_at, u.created_at, u.updated_at,
		       COALESCE((
		           SELECT sum(jsonb_array_length(COALESCE(g->'links', '[]'::jsonb)))
		           FROM jsonb_array_elements(COALESCE(d.payload->'groups', '[]'::jsonb)) AS g
		       ), 0)::int AS cloud_links,
		       COALESCE(jsonb_array_length(COALESCE(d.payload->'groups', '[]'::jsonb)), 0)::int AS cloud_groups,
		       (SELECT count(*) FROM user_secrets s WHERE s.user_id = u.id)::int AS cloud_secrets,
		       count(*) OVER()::int AS total
		FROM users u
		LEFT JOIN documents d ON d.user_id = u.id
		WHERE $1 = '' OR u.email ILIKE '%' || $1 || '%'
		ORDER BY u.created_at DESC
		LIMIT $2 OFFSET $3`, search, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	users := make([]AdminUser, 0, limit)
	for rows.Next() {
		var user AdminUser
		if err := rows.Scan(
			&user.ID, &user.Email, &user.PasswordHash, &user.EmailVerifiedAt,
			&user.IsAdmin, &user.DisabledAt, &user.CreatedAt, &user.UpdatedAt,
			&user.CloudLinks, &user.CloudGroups, &user.CloudSecrets, &total,
		); err != nil {
			return nil, 0, err
		}
		users = append(users, user)
	}
	return users, total, rows.Err()
}

// SetUserAdmin grants or revokes administrator access.
func (s *Store) SetUserAdmin(ctx context.Context, id uuid.UUID, admin bool) error {
	tag, err := s.pool.Exec(ctx, `UPDATE users SET is_admin = $2, updated_at = now() WHERE id = $1`, id, admin)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetUserDisabled enables or disables an account.
func (s *Store) SetUserDisabled(ctx context.Context, id uuid.UUID, disabled bool) error {
	var disabledAt *time.Time
	if disabled {
		now := time.Now()
		disabledAt = &now
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE users
		SET disabled_at = $2, updated_at = now()
		WHERE id = $1`, id, disabledAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
