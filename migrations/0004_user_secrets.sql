-- +goose Up

-- Encrypted secrets (AI provider config, memos, privacy space).
-- The server only ever stores the v4 ciphertext envelope: it never sees
-- plaintext AI keys, memo bodies or privacy content. There is intentionally
-- no admin endpoint that reads this table.
CREATE TABLE user_secrets (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('ai', 'memo', 'privacy')),
    payload jsonb NOT NULL,
    revision bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind)
);

-- +goose Down

DROP TABLE IF EXISTS user_secrets;
