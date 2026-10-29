package store

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// AIUsageRecord is one proxied AI API call. It deliberately contains no prompt,
// response, or API key content.
type AIUsageRecord struct {
	Provider     string
	Model        string
	Kind         string
	Status       string
	InputTokens  int
	OutputTokens int
	DurationMS   int
}

// AIUsageProvider aggregates one provider's usage over the recent window.
type AIUsageProvider struct {
	Provider     string    `json:"provider"`
	Calls        int64     `json:"calls"`
	Errors       int64     `json:"errors"`
	CallsToday   int64     `json:"callsToday"`
	Calls7Days   int64     `json:"calls7Days"`
	InputTokens  int64     `json:"inputTokens"`
	OutputTokens int64     `json:"outputTokens"`
	LastCalledAt time.Time `json:"lastCalledAt"`
}

// AIUsageEvent is one recent call shown in the overview.
type AIUsageEvent struct {
	Provider     string    `json:"provider"`
	Model        string    `json:"model"`
	Kind         string    `json:"kind"`
	Status       string    `json:"status"`
	InputTokens  int       `json:"inputTokens"`
	OutputTokens int       `json:"outputTokens"`
	DurationMS   int       `json:"durationMs"`
	CreatedAt    time.Time `json:"createdAt"`
}

// AIUsageSummary is the user-facing usage overview.
type AIUsageSummary struct {
	Providers []AIUsageProvider `json:"providers"`
	Recent    []AIUsageEvent    `json:"recent"`
}

// CountAIUsageSince counts successful calls of one kind since a timestamp. It
// backs the daily quota so the limit survives restarts and is shared by every
// instance using the same database.
func (s *Store) CountAIUsageSince(ctx context.Context, userID uuid.UUID, kind string, since time.Time) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*)
		FROM ai_usage
		WHERE user_id = $1 AND kind = $2 AND status = 'ok' AND created_at >= $3`,
		userID, kind, since).Scan(&count)
	return count, err
}

// RecordAIUsage appends one call metadata row.
func (s *Store) RecordAIUsage(ctx context.Context, userID uuid.UUID, rec AIUsageRecord) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ai_usage (user_id, provider, model, kind, status, input_tokens, output_tokens, duration_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		userID, rec.Provider, rec.Model, rec.Kind, rec.Status, rec.InputTokens, rec.OutputTokens, rec.DurationMS)
	return err
}

// DeleteOldAIUsage prunes call metadata outside the retention window.
func (s *Store) DeleteOldAIUsage(ctx context.Context, olderThan time.Duration) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM ai_usage WHERE created_at < $1`, time.Now().Add(-olderThan))
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// AIUsageSummary reads 30-day provider aggregates and the most recent calls.
func (s *Store) AIUsageSummary(ctx context.Context, userID uuid.UUID, dayStart time.Time) (AIUsageSummary, error) {
	out := AIUsageSummary{Providers: []AIUsageProvider{}, Recent: []AIUsageEvent{}}

	rows, err := s.pool.Query(ctx, `
		SELECT provider,
		       count(*) AS calls,
		       count(*) FILTER (WHERE status = 'error') AS errors,
		       count(*) FILTER (WHERE created_at >= $2) AS calls_today,
		       count(*) FILTER (WHERE created_at >= now() - interval '7 days') AS calls_7d,
		       coalesce(sum(input_tokens), 0) AS input_tokens,
		       coalesce(sum(output_tokens), 0) AS output_tokens,
		       max(created_at) AS last_called_at
		FROM ai_usage
		WHERE user_id = $1 AND created_at >= now() - interval '30 days'
		GROUP BY provider
		ORDER BY calls DESC, provider`, userID, dayStart)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item AIUsageProvider
		if err := rows.Scan(
			&item.Provider,
			&item.Calls,
			&item.Errors,
			&item.CallsToday,
			&item.Calls7Days,
			&item.InputTokens,
			&item.OutputTokens,
			&item.LastCalledAt,
		); err != nil {
			rows.Close()
			return out, err
		}
		out.Providers = append(out.Providers, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	recent, err := s.pool.Query(ctx, `
		SELECT provider, model, kind, status, input_tokens, output_tokens, duration_ms, created_at
		FROM ai_usage
		WHERE user_id = $1
		ORDER BY created_at DESC
		LIMIT 30`, userID)
	if err != nil {
		return out, err
	}
	defer recent.Close()
	for recent.Next() {
		var item AIUsageEvent
		if err := recent.Scan(
			&item.Provider,
			&item.Model,
			&item.Kind,
			&item.Status,
			&item.InputTokens,
			&item.OutputTokens,
			&item.DurationMS,
			&item.CreatedAt,
		); err != nil {
			return out, err
		}
		out.Recent = append(out.Recent, item)
	}
	if err := recent.Err(); err != nil {
		return out, err
	}
	return out, nil
}
