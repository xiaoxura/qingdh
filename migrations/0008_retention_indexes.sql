-- +goose Up

-- Maintenance and admin aggregate indexes.
CREATE INDEX IF NOT EXISTS email_tokens_expires_at_idx ON email_tokens (expires_at);
CREATE INDEX IF NOT EXISTS ai_usage_created_at_idx ON ai_usage (created_at);
CREATE INDEX IF NOT EXISTS documents_payload_version_idx ON documents ((payload->>'version'));

-- (user_id, created_at DESC) already covers the provider lookup.
DROP INDEX IF EXISTS ai_usage_user_provider_idx;

-- +goose Down

CREATE INDEX IF NOT EXISTS ai_usage_user_provider_idx ON ai_usage (user_id, provider);
DROP INDEX IF EXISTS documents_payload_version_idx;
DROP INDEX IF EXISTS ai_usage_created_at_idx;
DROP INDEX IF EXISTS email_tokens_expires_at_idx;
