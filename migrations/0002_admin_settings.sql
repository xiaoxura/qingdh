-- +goose Up
-- Admin accounts and runtime-configurable site settings. Everything that can
-- change while the service is running lives in the settings table instead of
-- config.yml.

ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN disabled_at timestamptz;
CREATE INDEX users_is_admin_idx ON users (is_admin) WHERE is_admin;

CREATE TABLE settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE settings;
DROP INDEX IF EXISTS users_is_admin_idx;
ALTER TABLE users DROP COLUMN disabled_at;
ALTER TABLE users DROP COLUMN is_admin;
