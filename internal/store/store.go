// Package store contains all PostgreSQL access. Queries are written by hand
// with pgx so that contributors do not need a code generator.
package store

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Common errors returned by the store. Handlers map them to HTTP responses.
var (
	ErrNotFound      = errors.New("store: not found")
	ErrConflict      = errors.New("store: revision conflict")
	ErrEmailTaken    = errors.New("store: email already registered")
	ErrTokenInvalid  = errors.New("store: token invalid, used or expired")
	ErrSessionAbsent = errors.New("store: session not found")
)

// Store wraps a PostgreSQL connection pool.
type Store struct {
	pool *pgxpool.Pool
}

// Open connects to PostgreSQL and verifies the connection.
func Open(ctx context.Context, dsn string, maxConns int) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	if maxConns <= 0 {
		maxConns = 10
	}
	cfg.MaxConns = int32(maxConns)
	cfg.MinConns = 1
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 15 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect database: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// Exec runs a statement without parameters, used by maintenance tasks and
// tests.
func (s *Store) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return s.pool.Exec(ctx, sql, args...)
}

// Ping checks database connectivity for readiness probes.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// PoolStats reports connection-pool utilisation for /metrics.
func (s *Store) PoolStats() (acquired, idle, total, max int32) {
	stat := s.pool.Stat()
	return stat.AcquiredConns(), stat.IdleConns(), stat.TotalConns(), stat.MaxConns()
}

// Migrate applies embedded migrations inside an advisory lock so that several
// instances can start at the same time. The whole run uses one dedicated
// connection: pg_advisory_lock is session-scoped, so acquiring it on one pooled
// connection and unlocking on another would leak the lock.
func (s *Store) Migrate(ctx context.Context, files fs.FS) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationLockID); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, migrationLockID)
	}()

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version text PRIMARY KEY,
		applied_at timestamptz NOT NULL DEFAULT now()
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[string]bool{}
	rows, err := conn.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			rows.Close()
			return err
		}
		applied[version] = true
	}
	rows.Close()
	if rows.Err() != nil {
		return rows.Err()
	}

	entries, err := fs.Glob(files, "*.sql")
	if err != nil {
		return err
	}
	sort.Strings(entries)

	for _, name := range entries {
		if applied[name] {
			continue
		}
		raw, err := fs.ReadFile(files, name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		up := upSection(string(raw))
		if strings.TrimSpace(up) == "" {
			return fmt.Errorf("migration %s has no -- +goose Up section", name)
		}

		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, up); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply migration %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, name); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record migration %s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit migration %s: %w", name, err)
		}
	}
	return nil
}

const migrationLockID int64 = 0x71696e676468 // "qingdh"

// upSection extracts SQL between the goose Up marker and the Down marker.
func upSection(sql string) string {
	lower := strings.ToLower(sql)
	start := strings.Index(lower, "-- +goose up")
	if start == -1 {
		return sql
	}
	rest := sql[start:]
	if idx := strings.Index(strings.ToLower(rest), "-- +goose down"); idx != -1 {
		rest = rest[:idx]
	}
	return rest
}

// isUniqueViolation reports a PostgreSQL unique constraint violation on the
// given constraint name.
func isUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	return pgErr.Code == "23505" && (constraint == "" || pgErr.ConstraintName == constraint)
}

// withTx runs fn inside a transaction, committing on success.
func (s *Store) withTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()

	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
