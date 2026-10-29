-- +goose Up

-- Per-user metadata for proxied AI calls. No prompts, responses, or API keys
-- are stored here; only provider/model identifiers, token counts and timing.
CREATE TABLE ai_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    model text NOT NULL DEFAULT '',
    kind text NOT NULL CHECK (kind IN ('chat', 'test', 'models', 'balance')),
    status text NOT NULL CHECK (status IN ('ok', 'error')),
    input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_user_created_idx ON ai_usage (user_id, created_at DESC);
CREATE INDEX ai_usage_user_provider_idx ON ai_usage (user_id, provider);

-- +goose Down

DROP TABLE IF EXISTS ai_usage;
