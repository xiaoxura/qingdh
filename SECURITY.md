# 安全策略

## 支持范围

安全修复针对 `main` 分支的最新版本。旧版本或自行修改过的部署不保证获得修复。

## 私下报告

请不要在公开 Issue、Discussion 或 PR 中披露漏洞细节、利用代码、真实用户数据或凭据。

优先使用 GitHub 仓库的 **Security → Report a vulnerability**（Private vulnerability reporting）。如果该入口不可用，请通过仓库维护者公开资料中的联系方式私下联系，并附上：

- 受影响的版本或 commit；
- 复现步骤和影响范围；
- 必要的请求/响应片段（请先脱敏）；
- 你希望的披露时间。

## 重点范围

本项目重点关注：

- 认证、会话、CSRF、开放重定向、账号枚举；
- 客户端加密、Device Vault、Passkey 的密钥处理与降级路径；
- AI 代理的密钥泄露、SSRF、提示词注入边界；
- favicon 代理的 SSRF / 内网访问；
- 邮件 token、限流、权限提升、越权读取；
- XSS、CSP 绕过、Service Worker 缓存污染；
- 管理后台的权限校验和审计。
- 依赖供应链与容器镜像。

以下通常不视为本项目漏洞：

- 需要物理接触已解锁设备、恶意浏览器扩展、键盘记录器或已被入侵的操作系统；
- 用户自行把 `config.yml`、数据库备份、API Key 或 `TEST_ACCOUNTS.md` 提交到公开仓库；
- 纯 HTTP 公网部署导致的凭据嗅探（请使用 HTTPS）；
- 未配置 `trusted_proxies` / `trusted_hosts` 的自担风险部署；
- 仅影响已被官方停止维护的浏览器版本的问题。

## 部署建议

- 公网必须使用 HTTPS；反向代理终止 TLS 时配置 `server.trusted_proxies` 和 `server.trusted_hosts`。
- `config.yml` 权限设为 `600`，不要提交到仓库；数据库备份按敏感数据保护。
- 如启用 `/metrics`，设置高熵 `server.metrics_token`，不要暴露到公网。
- 开启邮箱验证和 SMTP，定期轮换 SMTP 凭据。
- 鼓励用户开启客户端加密；但请理解它不能防御服务端恶意替换前端代码。
- 定期更新 Go 依赖并关注 `govulncheck` 结果。

## 披露

修复发布后，会在 release notes 或 commit 中说明影响范围；在修复可用前，请给维护者合理的处理时间。
