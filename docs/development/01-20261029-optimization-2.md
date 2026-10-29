# 第二轮优化（2026-10-29）

## 范围

本轮按 Review 的 1–10 项落地，保持既有同步/加密协议、零构建前端和单二进制部署不变。

1. **静态资源**：启动时构建资源包，按内容 SHA-256 生成 ETag，预压缩 gzip；带 `?v=` 的资源返回 `immutable` 长缓存，HTML 保持 `no-cache` + ETag。`/ai`、`/admin` 也复用同一资源包。Service Worker 预缓存改用版本化 URL，所有 `cache.put` 纳入 `waitUntil`。
2. **关闭前保存**：备忘录在 `visibilitychange=hidden` / `pagehide` 立即提交防抖中的编辑；隐私空间在隐藏/离开时先尽力保存，bfcache 恢复时再锁定。
3. **AI 流式渲染**：deltas 追加到文本节点，只在结束时跑一次 Markdown；滚动用 rAF 合并；`aria-live` 从正文移到状态行，正文用 `aria-busy`。
4. **搜索热路径**：备忘录按 `updatedAt` 缓存小写搜索文本（正文最多 8 KiB），列表输入只替换当前项；命令面板建议 120ms 防抖，正文不再每次按键 `toLowerCase()`。
5. **AI 配额与 SSE**：日配额改为按 `ai_usage` 中当天成功 `chat` 统计，重启/多实例口径一致；SSE 每次写事件续写超时；优雅退出超时只告警并返回 0。
6. **邮件流程**：新增有界邮件队列 + 后台重试；注册/重置立即返回，测试邮件仍同步。验证链接 GET 只渲染确认页，POST 才消费 token 并签发会话，避免邮件扫描器提前用掉 token。
7. **反向代理**：HTTPS 站点地址会推导 Secure Cookie 并发送 HSTS；缺少 `trusted_proxies` 时启动告警；same-origin 校验使用实际请求协议，不受 baseURL 影响。
8. **后台**：`settings` 增加 `version` 乐观锁，冲突返回 409 并让后台刷新；新增 `audit_log`，记录设置修改、授权/禁用/删除用户、查看用户工作区、自助删号、密码重置。
9. **运维**：`ai_usage` 90 天、`audit_log` 365 天保留；补 `email_tokens(expires_at)` 等索引；后台概览改为单次聚合、用户列表去掉重复 count；新增可选 `server.metrics_token` + `/metrics`；静态资源日志降为 debug；CI 增加 staticcheck、govulncheck、覆盖率与容器冒烟。
10. **前端结构**：抽出 `lib/core.js`（URL/转义/图标等纯函数，UMD，零构建）并用 `node:test` 覆盖；memo/ai/privacy/command-palette/passkey/avatars 改为首屏后按需注入；快捷方式 favicon 改为同源 `/api/favicon` 代理 + 内存缓存，代理拒绝内网/回环/保留地址；代理失败时浏览器对该图标直连一次再回退首字母；首页模式按钮显示当前搜索引擎/供应商图标（直接读取其站点 favicon，失败回退首字母或星芒）；修复引擎名转义、备忘录列表 ARIA、批量选择整页重渲染；移除账号按钮上始终为绿色的状态点，避免与「已同步」状态点重复；产品名由「轻导航」统一改为「氢导航」；Passkey 明确区分 IP 地址/无平台验证器/用户取消三种情况。

## 验证

- `go test -race ./...` 通过；`go vet ./...`、`staticcheck ./...` 无告警。
- `node --test web-tests/unit/*.test.mjs` 7 项通过。
- 所有根目录与 `lib/` JavaScript `node --check` 通过。
- 独立数据库 + `127.0.0.1:8081` 上运行 `web-tests/reliability.mjs`：19/19 通过，新增备忘录搜索、懒加载模块和 pagehide 保存检查。
- 8081 响应头确认 `/app.js?v=20261029-30` 返回 gzip、ETag、`immutable`；带 `If-None-Match` 返回 304；`/`、`/ai`、`/admin` 返回 gzip + ETag + `no-cache`。
- `/metrics` 无 token 401，带 token 返回 HTTP/AI/DB pool 指标。
- favicon 代理对 `127.0.0.1`、`10.0.0.1`、`169.254.169.254`、`198.18.x`、`file://`、`javascript:` 均拒绝。

## 兼容边界

- 旧 v2/v3/v4 数据与同步协议未改动；settings 旧行 version=0，首次保存按 base 0 正常升级。
- 邮件验证现在多一次“确认验证”点击；未配置 SMTP 时仍自动关闭验证。
- `/metrics` 默认关闭，需在 `config.yml` 设置 `server.metrics_token`；不配置时接口 404。
- favicon 代理只抓取 `/favicon.ico` 且仅接受栅格图片；SVG 故意排除，避免同源文档 XSS；部分站点可能回退为首字母色块。
- 前端仍是零构建 classic script；`lib/core.js` 使用 UMD，浏览器与 `node:test` 共用。

## 服务更新

8081 为独立数据库冒烟实例，已停止；测试数据库已删除。8080 已通过临时 systemd 单元 `qingdh-8080.service` 重启并加载本轮构建（`20261029-36`），旧进程已退出，迁移 0006–0008 已应用；`/healthz`、`/readyz` 返回 200。该单元带 `Restart=on-failure`，但为 transient 单元，不随宿主重启自动恢复；如需开机自启，应另建持久 systemd unit 或沿用原有启动方式。
