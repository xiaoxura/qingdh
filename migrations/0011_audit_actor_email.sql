-- +goose Up

-- 审计日志保存操作者邮箱快照：管理员账号被删除后 actor_id 会置空，但追责
-- 信息仍然可读。actor_email 是普通列，不包含密码、token 或用户内容。
ALTER TABLE audit_log ADD COLUMN actor_email text NOT NULL DEFAULT '';

CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC);

-- +goose Down

DROP INDEX IF EXISTS audit_log_action_idx;
ALTER TABLE audit_log DROP COLUMN actor_email;
