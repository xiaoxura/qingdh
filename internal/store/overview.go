package store

import "context"

// AdminOverview is the aggregate dashboard shown in the admin console. It only
// exposes counts, never document or secret content.
type AdminOverview struct {
	UsersTotal          int64 `json:"usersTotal"`
	UsersVerified       int64 `json:"usersVerified"`
	UsersAdmins         int64 `json:"usersAdmins"`
	UsersDisabled       int64 `json:"usersDisabled"`
	UsersNew7Days       int64 `json:"usersNew7Days"`
	SessionsActive      int64 `json:"sessionsActive"`
	DocumentsTotal      int64 `json:"documentsTotal"`
	DocumentsEncrypted  int64 `json:"documentsEncrypted"`
	DocumentsUpdated24h int64 `json:"documentsUpdated24h"`
	SecretsAI           int64 `json:"secretsAI"`
	SecretsMemo         int64 `json:"secretsMemo"`
	SecretsPrivacy      int64 `json:"secretsPrivacy"`
}

// AdminOverview counts accounts, sessions, documents and encrypted secret rows.
func (s *Store) AdminOverview(ctx context.Context) (AdminOverview, error) {
	var out AdminOverview
	// One scan per table instead of twelve correlated count subqueries.
	err := s.pool.QueryRow(ctx, `
		WITH u AS (
			SELECT count(*) AS total,
			       count(*) FILTER (WHERE email_verified_at IS NOT NULL) AS verified,
			       count(*) FILTER (WHERE is_admin) AS admins,
			       count(*) FILTER (WHERE disabled_at IS NOT NULL) AS disabled,
			       count(*) FILTER (WHERE created_at > now() - interval '7 days') AS new_7d
			FROM users
		),
		d AS (
			SELECT count(*) AS total,
			       count(*) FILTER (WHERE payload->>'version' = '3') AS encrypted,
			       count(*) FILTER (WHERE updated_at > now() - interval '24 hours') AS updated_24h
			FROM documents
		),
		s AS (
			SELECT count(*) FILTER (WHERE kind = 'ai') AS ai,
			       count(*) FILTER (WHERE kind = 'memo') AS memo,
			       count(*) FILTER (WHERE kind = 'privacy') AS privacy
			FROM user_secrets
		)
		SELECT u.total, u.verified, u.admins, u.disabled, u.new_7d,
		       (SELECT count(*) FROM sessions WHERE expires_at > now()),
		       d.total, d.encrypted, d.updated_24h,
		       s.ai, s.memo, s.privacy
		FROM u, d, s
	`).Scan(
		&out.UsersTotal,
		&out.UsersVerified,
		&out.UsersAdmins,
		&out.UsersDisabled,
		&out.UsersNew7Days,
		&out.SessionsActive,
		&out.DocumentsTotal,
		&out.DocumentsEncrypted,
		&out.DocumentsUpdated24h,
		&out.SecretsAI,
		&out.SecretsMemo,
		&out.SecretsPrivacy,
	)
	return out, err
}
