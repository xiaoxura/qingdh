-- +goose Up

ALTER TABLE sessions ADD COLUMN device_id text NOT NULL DEFAULT '';

-- Collapse duplicate sessions created by repeated logins from the same browser
-- before device IDs existed. Keep the most recently used row per user/UA/IP.
DELETE FROM sessions a
USING sessions b
WHERE a.user_id = b.user_id
  AND a.user_agent = b.user_agent
  AND a.ip = b.ip
  AND (a.last_seen_at, a.id) < (b.last_seen_at, b.id);

CREATE UNIQUE INDEX sessions_user_device_idx
    ON sessions (user_id, device_id)
    WHERE device_id <> '';

-- +goose Down

DROP INDEX IF EXISTS sessions_user_device_idx;
ALTER TABLE sessions DROP COLUMN device_id;
