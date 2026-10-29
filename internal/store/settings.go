package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// SettingsKey is the single row holding site-wide runtime settings.
const SettingsKey = "site"

// GetSettings returns the raw JSON document for key.
func (s *Store) GetSettings(ctx context.Context, key string) (json.RawMessage, error) {
	raw, _, err := s.GetSettingsVersioned(ctx, key)
	return raw, err
}

// GetSettingsVersioned returns the raw JSON and its optimistic-concurrency
// version.
func (s *Store) GetSettingsVersioned(ctx context.Context, key string) (json.RawMessage, int64, error) {
	var raw json.RawMessage
	var version int64
	err := s.pool.QueryRow(ctx, `SELECT value, version FROM settings WHERE key = $1`, key).Scan(&raw, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, ErrNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	return raw, version, nil
}

// PutSettings upserts the JSON document for key and returns the new version.
// It is the unconditional path used by internal callers and tests.
func (s *Store) PutSettings(ctx context.Context, key string, value []byte) (int64, error) {
	var version int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO settings (key, value, version, updated_at)
		VALUES ($1, $2::jsonb, 1, now())
		ON CONFLICT (key) DO UPDATE
		SET value = EXCLUDED.value,
		    version = settings.version + 1,
		    updated_at = now()
		RETURNING version`, key, value).Scan(&version)
	return version, err
}

// PutSettingsVersioned writes value only when the stored version equals base.
// A missing row is only created when base is zero. ErrConflict is returned for
// stale writers so the UI can reload instead of silently overwriting another
// administrator's group.
func (s *Store) PutSettingsVersioned(ctx context.Context, key string, value []byte, base int64) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var current int64
	err = tx.QueryRow(ctx, `SELECT version FROM settings WHERE key = $1 FOR UPDATE`, key).Scan(&current)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		if base != 0 {
			return 0, ErrConflict
		}
		if err := tx.QueryRow(ctx, `
			INSERT INTO settings (key, value, version, updated_at)
			VALUES ($1, $2::jsonb, 1, now())
			RETURNING version`, key, value).Scan(&current); err != nil {
			if isUniqueViolation(err, "settings_pkey") {
				return 0, ErrConflict
			}
			return 0, err
		}
	case err != nil:
		return 0, err
	default:
		if current != base {
			return 0, ErrConflict
		}
		if err := tx.QueryRow(ctx, `
			UPDATE settings
			SET value = $2::jsonb, version = version + 1, updated_at = now()
			WHERE key = $1
			RETURNING version`, key, value).Scan(&current); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return current, nil
}
