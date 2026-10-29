-- +goose Up

-- 修改邮箱采用“待验证地址 + 一次性 token”：确认前 users.email 保持不变。
ALTER TABLE users ADD COLUMN pending_email text;

-- email_tokens.kind 增加 change_email。
ALTER TABLE email_tokens DROP CONSTRAINT IF EXISTS email_tokens_kind_check;
ALTER TABLE email_tokens ADD CONSTRAINT email_tokens_kind_check
    CHECK (kind IN ('verify_email', 'reset_password', 'change_email'));

-- +goose Down

ALTER TABLE email_tokens DROP CONSTRAINT IF EXISTS email_tokens_kind_check;
ALTER TABLE email_tokens ADD CONSTRAINT email_tokens_kind_check
    CHECK (kind IN ('verify_email', 'reset_password'));
ALTER TABLE users DROP COLUMN pending_email;
