-- +goose Up

-- 普通工作区的服务端历史快照。每次成功的 workspace PUT 追加一条；
-- 保留策略由 cleanupLoop 执行（每用户最多 20 份、最多 30 天）。
CREATE TABLE document_revisions (
    id bigserial PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revision bigint NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, revision)
);
CREATE INDEX document_revisions_user_created_idx
    ON document_revisions (user_id, created_at DESC);

-- +goose Down

DROP TABLE document_revisions;
