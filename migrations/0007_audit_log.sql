-- +goose Up

-- Append-only trail for privileged and destructive actions. Detail must never
-- contain passwords, tokens or decrypted user content.
CREATE TABLE audit_log (
    id bigserial PRIMARY KEY,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    target_id uuid,
    action text NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_at_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC);

-- +goose Down

DROP TABLE audit_log;
