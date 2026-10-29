-- +goose Up

-- Optimistic concurrency for the runtime settings row. Admins edit disjoint
-- groups in the UI, but two simultaneous saves used to be last-write-wins.
ALTER TABLE settings ADD COLUMN version bigint NOT NULL DEFAULT 0;

-- +goose Down

ALTER TABLE settings DROP COLUMN version;
