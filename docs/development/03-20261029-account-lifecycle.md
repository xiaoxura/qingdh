# 下一阶段开发计划：账号与数据生命周期（2026-10-29）

> 状态：计划，待实施
> 上一阶段：设置与账号弹窗整理（`02-20261029-settings-hub.md`）
> 范围：账号安全、加密生命周期、数据可恢复性、审计、同步效率、前端结构
> 原则：不改变 v2/v3/v4 数据格式与同步协议；不引入前端框架或构建步骤；不破坏单二进制部署。

## 1. 背景与结论

本阶段开始前对现有代码做了一次完整通读，并运行了：

```bash
go vet ./...
go test ./...
node --test web-tests/unit/*.test.mjs
```

结果：Go 测试全绿（`internal/httpapi` 集成测试约 4s，使用 embedded-postgres）；前端 8 个纯函数单测通过。`web-tests/reliability.mjs` 未在现有 8080 数据上运行，避免写入测试账号。

三个判断：

1. **后端基础扎实**：路由、中间件、限流、加密边界和测试都在水平线以上，已有约 85 个 Go 测试覆盖注册、会话、同步、secret、AI 代理与后台。
2. **产品生命周期有缺口**：没有登录态改密 / 换邮箱入口；加密恢复码只能生成一次；服务端没有导航文档历史；审计日志只写不读。
3. **前端开始成为瓶颈**：`web/app.js` 已 6333 行、约 60 个可变全局状态，并存在几个已确认的数据正确性问题。继续在单文件里堆账号与加密 UI，风险会持续上升。

因此本阶段不从“再加一个入口”开始，而是把**账号、密钥、数据三件事补成可长期托付的闭环**。

## 2. 目标与非目标

### 2.1 目标

- 登录用户可自助修改登录密码和邮箱；改密后其他设备退出。
- 加密恢复码可重新生成；明确“关闭加密”的处置方式。
- 导航文档保留可回滚的历史版本。
- 管理员可以在后台查看审计日志。
- 修复已确认的前端/后端缺陷，并补上对应的回归测试。
- 降低首屏与同步开销，给 `app.js` 划出可测试的模块边界。
- 收口当前未提交的改动，发布 `v0.1.0` 基线。

### 2.2 非目标（本阶段不做）

- TOTP / Passkey 登录、Passkey H2 服务端可信设备与远程撤销。
- 附件、图片、多人协作、共享空间、实时同步、Web Push。
- 服务端全文搜索（与“服务端不可读”边界冲突）。
- AI 多供应商矩阵与计费体系（放在下一阶段单独评估）。
- i18n、多实例 Redis 限流。
- 任何会改变 v2/v3/v4 数据格式或同步协议的改造。

## 3. 主线 A：账号与数据生命周期（约 1–1.5 周）

### A1 登录密码修改

**现状**：只有注册、登录、邮件重置和 CLI `qingdh user passwd`，没有登录态改密接口。账号面板只有退出和删号（`web/index.html`）。

**接口**

```text
POST /api/v1/auth/password
{ "currentPassword": "...", "newPassword": "..." }
```

**服务端**

1. `requireAuth`；校验当前密码 `auth.VerifyPassword`，失败返回 `403 invalid_password`。
2. `auth.ValidatePassword` 校验新密码；与旧密码相同直接拒绝。
3. Argon2id 生成新 hash。
4. 新增 `Store.UpdatePasswordAndRevokeOtherSessions(ctx, userID, hash, keepSessionID)`：在单事务里更新密码，并删除该用户除当前会话外的全部会话。不要复用会删光所有会话的 `UpdatePasswordAndRevokeSessions`。
5. 写审计 `account.password_change`；配置 SMTP 时发送“密码已修改”通知邮件。
6. 限流：新增 per-user 策略（建议 5 次/分钟，burst 3）。

**前端**

- 账号面板增加「修改登录密码」按钮，复用统一 dialog 风格。
- 表单：当前密码、新密码、确认新密码；成功提示“其他设备已退出登录”。
- 失败态：当前密码错误、两次输入不一致、新密码过短、网络失败。

**测试**

- 当前密码错误 → 403；新密码过短 → 422；与旧密码相同 → 422。
- 成功后：当前会话仍可用，其他设备会话 401，审计存在。
- 未登录 → 401；超过限流 → 429。

### A2 邮箱修改

**现状**：邮箱不可修改；写错只能删号重建。现有 `email_tokens.kind` 只有 `verify_email` / `reset_password`。

**数据迁移**（`migrations/0009_email_change.sql`，仅 Up，向前兼容）

```sql
ALTER TABLE users ADD COLUMN pending_email text;
ALTER TABLE email_tokens DROP CONSTRAINT IF EXISTS email_tokens_kind_check;
ALTER TABLE email_tokens ADD CONSTRAINT email_tokens_kind_check
  CHECK (kind IN ('verify_email', 'reset_password', 'change_email'));
```

**接口与流程**

1. `POST /api/v1/auth/email-change` `{password, newEmail}`
   - 校验当前密码；规范化新邮箱；若已被占用，与注册保持一致返回 `409 email_taken`（如希望避免枚举，可统一返回 202，只在邮件里说明结果）。
   - 写入 `users.pending_email`，创建 `kind='change_email'` 的一次性 token，发往**新邮箱**。
2. `GET /change-email?token=` 只渲染确认页，不消费 token（沿用现有邮箱验证页防扫描器逻辑）。
3. `POST /change-email` 消费 token：
   - 校验 token 用户、`pending_email` 仍存在且未变化；
   - 再次检查新邮箱未被占用；
   - 更新 `users.email`、`email_verified_at=now()`、清空 `pending_email`；
   - 撤销该用户的其他会话：如果确认请求带有该用户的会话则保留当前会话，否则撤销全部；
   - 向**旧邮箱**发送“邮箱已变更”通知；
   - 写审计 `account.email_change`。

**前端**

- 账号面板增加「修改邮箱」，显示当前邮箱和“待验证新邮箱”状态。
- 确认页使用与验证邮箱一致的最小页面样式。

**测试**

- 新邮箱占用、token 过期/重复使用、pending 被覆盖、旧邮箱通知、其他会话失效、审计。
- 未配置 SMTP 时按钮禁用并说明原因（改邮箱必须依赖邮件）。

### A3 恢复码重新生成

**现状**：`crypto.js` 只在开启加密时生成一次恢复码；之后只能“修改加密密码”，无法更换恢复码。恢复码丢失即失去第二条找回路径。

**实现**

- 在 `web/crypto.js` 增加 `rewrapRecovery(envelope, password, options)`：
  1. 用当前密码解出 `dataKey`（或允许用旧恢复码解）；
  2. 生成新的 20 字节恢复码；
  3. 只替换 `envelope.recovery.wrappedKey`，保持 `salt` / `wrappedKey` / `check` / `data` 不变；
  4. 返回新 envelope 和新恢复码。
- UI 放在「安全与隐私 → 数据加密」：输入当前密码 → 展示新恢复码（复制/下载）→ 勾选“已离线保存” → 以当前 revision 上传。
- 服务端无需改动：`docval` 已校验 v3 envelope 的 recovery 长度。
- Device Vault 继续有效（`check` 不变，`envelopeId` 不变）。

**测试**

- 新恢复码可解锁、旧恢复码失败、密码解锁不受影响、`data` 解密结果不变。
- 新增 `web-tests/unit/crypto.test.mjs`，覆盖上述用例以及错误密码、篡改密文、AAD/kind 混淆。

### A4 关闭加密（决策点，建议本轮只留设计）

**问题**：用户开启加密后无法回到明文。直接放宽 `PUT /workspace` 会破坏现有的降级防护（当前 v3 → v2 会返回 `422 encryption_required`，见 `internal/httpapi/workspace_handlers.go`）。

**建议**：本轮**不实现**关闭加密，只完成 A3（重新生成恢复码）。理由：

- 关闭加密需要新的安全语义：谁有权降级、如何确认、历史备份中的密文是否仍算泄露；
- 任何 XSS 都能触发降级，和“读取数据”同级，需要单独的威胁模型说明；
- 恢复码重生成已经覆盖“丢失第二条找回路径”的主要痛点。

**若决定本轮实现**，采用显式端点而不是放宽 PUT：

```text
POST /api/v1/workspace/disable-encryption
{ "baseRevision": 12, "payload": { ...v2 明文... } }
```

服务端校验 `baseRevision`、明文 v2 结构、当前文档确为 v3；写入后 revision+1，并写审计 `account.encryption_disabled`。前端必须二次确认，并提示“历史备份和已删除数据中的密文不会被清理”。该端点仍受同源 + JSON + 登录会话约束。

### A5 服务端版本历史

**现状**：`documents` 只存当前 payload（`internal/store/documents.go`）；前端只有一份 `qingdh.backup.v1` 本地快照，下一次合并就会覆盖。

**方案 A（推荐）**：保存最近 N 个 revision 的服务端快照。

迁移 `migrations/0010_document_revisions.sql`：

```sql
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
```

- `Store.UpdateDocument` 改为事务：条件 UPDATE 成功后，把**新 payload** 以新 revision 插入历史；当前版本也在历史里，UI 标注“当前”。
- 保留策略：每用户最多 20 份、最多 30 天；在 `cleanupLoop` 中清理。按 512 KiB 上限估算，单用户最坏约 10 MiB。
- 只覆盖普通工作区；memo / AI / privacy secret 的历史**不在本轮**（它们有自己的 revision 与冲突合并逻辑）。
- 读取接口：
  - `GET /api/v1/workspace/revisions` → `{revisions:[{revision, createdAt, size}]}`；
  - `GET /api/v1/workspace/revisions/{revision}` → `{revision, payload, createdAt}`。
  - 均按 `user_id` 作用域；不加管理员读取入口。
- 恢复：客户端取回历史 `payload` 后，走现有 `PUT /workspace`（以当前 revision 为 base），复用合并、校验与加密上传逻辑；服务端不新增恢复接口，减少一处权限面。
- 加密文档：历史里仍是 v3 密文，预览时由客户端解密；服务端不引入任何新的明文暴露面。

**方案 B（兜底）**：如果本轮时间不足，只做本地多快照（最近 5 份轮转 + 手动命名），把服务端历史放到下一轮。无论 A/B，前端「数据管理」都要提供“历史版本”入口。

**测试**

- 每次 PUT 生成一条历史；409 不生成；删除账号级联删除。
- 保留策略按数量与时间生效；跨用户不可读。
- 明文与加密文档都能预览并恢复；恢复后 revision 继续递增。
- 并发 PUT 时历史不重复、不丢失。

### A6 审计日志后台

**现状**：`audit_log` 已在写（设置修改、授权/禁用/删除用户、查看用户工作区、删号、密码重置），但 `ListAudit` 只被测试调用，没有 HTTP 入口；`actor_id` 在管理员被删除后置空（`ON DELETE SET NULL`），追责链断。

**服务端**

- 迁移 `migrations/0011_audit_actor_email.sql`：`audit_log ADD COLUMN actor_email text NOT NULL DEFAULT ''`。
- `Server.audit` 在写库时从请求上下文取当前用户邮箱，写入 `actor_email`；系统动作留空。邮箱是快照，不随用户删除消失。
- 新接口（管理员）：

```text
GET /api/v1/admin/audit?limit=50&offset=0&action=admin.user.update&actor=
```

返回 `{entries:[{id, actorId, actorEmail, targetId, action, detail, createdAt}], total}`；`limit` 上限 200。

**前端**

- 管理后台新增「审计」分类（或放在「用户管理」下的二级标签）：时间、操作者、动作、目标、详情；支持动作筛选与分页/加载更多。
- 不展示密码、token、密文或用户内容；detail 目前只含布尔值和版本号，保持这一约束。

**测试**

- 非管理员 403；分页与筛选；删除管理员后历史仍显示 `actor_email`；审计接口不返回 secret。

### A7 发布收口

- 先把当前未提交的 settings-hub 改动提交，形成一个可回滚的基线。
- 打 `v0.1.0` tag；确认 `qingdh version` 输出来自 `-ldflags -X main.version`。
- 增加 release workflow：tag 触发构建 linux/amd64 + arm64、推送 GHCR 镜像、生成 release notes 与校验和。
- 补升级/回滚文档：迁移只向前、备份先于升级、镜像回滚步骤。
- 管理后台显示当前版本（可通过只读端点或构建注入），便于排查“前端/后端版本错配”。

## 4. 前置缺陷修复 B（2–3 天，先于主线）

这些问题会直接影响主线的可靠性，必须在加账号/历史功能之前修掉。

### B1–B8 数据与行为缺陷

| ID | 问题 | 证据 | 修法 | 回归 |
| --- | --- | --- | --- | --- |
| B1 | 超出限额时保留**最旧**数据，且后面分组会饿死 | `web/app.js` `enforceLimits`：按 `updatedAt` 升序 `slice(0, MAX_GROUPS)`；链接预算跨组累加 | 墓碑优先丢、新者优先；每组配额；与注释一致 | 单测：51 个分组/501 条链接，保留最新 |
| B2 | 自定义搜索引擎无法被选中 | `web/app.js` `selectEngine` 只校验内置 `ENGINES`，但菜单用 `allEngines()` 渲染 | 改为 `allEngines().some(...)`；补 e2e | 添加自定义引擎后可从菜单选中并搜索 |
| B3 | 关闭“自动同步”后仍会在 focus/切标签/联网时同步 | 开关只挡 `scheduleSync`；focus/visibility/online 直接 `syncNow()` | 事件侧或 `syncNow` 统一判断 `prefs.autoSync`；手动同步不受影响 | 关闭开关后编辑不自动上传，手动同步仍可用 |
| B4 | 对话框 resolver 并发会永久悬挂 | `promptDecryptFile` 第二次调用 resolve 新 Promise；`promptUnlock` 覆盖前不 settle，且可能重复 `showModal()` | 抽 `openModal(dialog, resolve)`：先 settle 旧值，再判 `dialog.open` | 并发触发两个解锁/导入流程，均能结束 |
| B5 | Service Worker 把任意导航响应写成 shell | `web/service-worker.js` 所有 `navigate` 都 `cache.put('/index.html')` | 只允许 `/`、`/index.html`、`/ai` 写入；其余导航不缓存 | 访问 404 后离线打开仍是正常 shell |
| B6 | 桌面端隐藏侧栏仍可 Tab 聚焦 | `applySidebar` 只在移动端设 `inert` | 桌面 hidden 也 `inert`，焦点移到唤出按钮 | 隐藏后 Tab 不进入侧栏 |
| B7 | 续期写库失败被当成 500 | `auth/session.go` 注释“保持可用”，`middleware.go` 直接 500 | 续期失败降级为本次不续期，不拒绝请求 | 模拟续期错误，请求仍 200 |
| B8 | workspace 缺失行会永久 409 | `UpdateDocument` UPDATE 0 行即冲突，GET 有 fallback | 行不存在时按 revision 0 插入，逻辑对齐 `PutSecret` | 手动删除 documents 行后 PUT 可自愈 |

### B9 安全默认（顺手处理）

| 问题 | 证据 | 修法 |
| --- | --- | --- |
| Host 头可污染邮件链接 | `baseURL` 与 `trusted_hosts` 都为空时，`baseURLFor` 回退 `r.Host` | 启用 SMTP 前要求站点地址；未配置时拒绝发信或固定 Host；启动日志明确告警 |
| Argon2 无全局并发上限 | 每次登录/注册 19 MiB，仅按 IP 限流 | 加全局信号量（建议 4）；超限返回 503/429，不排队耗尽内存 |
| favicon 代理可拨任意端口 | `origin` 含端口，代理只校验公网 IP | 只允许 80/443（或配置白名单）；缓存改 LRU；必要时要求登录 |

## 5. 结构改造 C（2–3 天，可与主线并行）

### C1 拆分 `app.js` 的第一刀

不改协议、不引框架，只划边界：

- `web/lib/store.js`：`data` / `prefs` / `sync` 三片状态 + 订阅，替代散装全局。
- `web/lib/dialog.js`：统一 `openModal` / `settle` 帮助函数，顺带修 B4。
- `web/lib/render.js`：分组列表单一渲染 + 行级 patch，替代 8 条并行渲染路径。
- 保持 classic script + `globalThis.QingdhApp` 命名空间，零构建不变。
- 目标：6.3k 行降到 3–4 个 500–1500 行模块；行为不变，现有测试全绿。

### C2 补测试

- `web-tests/unit/crypto.test.mjs`：错误密码、恢复码、rewrap、AAD/kind 混淆、篡改密文、A3 新恢复码。
- Go revision 并发测试：N=8 同时 `PUT /workspace` 使用同一 `baseRevision`，断言恰好 1 个 200、其余 409、最终 revision=1、无 5xx。
- 补缺失接口的成功路径：`/auth/refresh`、`/auth/sessions` 列表、`/auth/logout-all`、`/account/export`。
- 把 B1/B3 等纯逻辑抽到 `web/lib/` 后做表驱动测试。

### C3 同步效率

- `GET /api/v1/workspace` 与 `GET /api/v1/secrets/{kind}` 支持 `ETag` + `If-None-Match`；客户端用本地 revision 作为 ETag 依据，命中返回 304。
- focus 同步加 30s 节流；`reconcile` 复用 `sync.inFlight` 单飞锁，避免登录拉取与 focus 拉取并发导致假冲突。
- memo 保存从 500ms 整包上传改为空闲 1.5–2s 合并 + 最长等待 5s；`pagehide` 仍立即 flush。
- `/api/v1/site` 的 Logo 改为可缓存（ETag 基于 settings version），避免 128 KiB data URL 每次刷新重传。

### C4 首屏瘦身

- 当前 `init()` 无条件加载 6 个可选模块（memo/ai/privacy/command-palette/passkey/avatars，约 54 KiB gzip）。第一步改为**首次使用任一可选功能时加载**，并让 `wireOptionalModules` 支持后加载模块的初始化；第二步再按模块拆分。
- 设置 Hub 与 21 个对话框（约 44 KiB HTML）可改为 `<template>` 首次打开时注入；注意 `dom` 表在解析时取元素，需要同步改造。
- 目标：首屏（不含按需模块）gzip 从约 150 KiB 降到 100 KiB 以内；用 `du`/DevTools 记录前后数据。

## 6. 排期（两周）

| 天 | 内容 | 产出 |
| --- | --- | --- |
| D1–D3 | B1–B9 + 安全默认；crypto/revision 测试；B1–B3 回归 | 缺陷清单清零 |
| D4 | A1 改密 | 账号自助闭环（一） |
| D5–D6 | A2 改邮箱（迁移 0009） | 账号自助闭环（二） |
| D7 | A3 恢复码重生成 + crypto 测试 | 加密第二条找回路径 |
| D8–D9 | A5 版本历史（迁移 0010）+ 数据管理入口 | 可回滚的导航文档 |
| D10 | A6 审计（迁移 0011）+ 后台页面 | 审计可查 |
| D11 | A7 发布收口：提交、tag、release workflow、文档 | `v0.1.0` |
| D12–D14 | C1 拆分第一刀、C2 测试、C3 同步效率、C4 首屏 | 结构基线 |

如果只有一周：**D1–D3 + A1 + A3 + A6**；A2、A5、A7 和 C1–C4 顺延到下一轮。

## 7. 验收标准

### 账号

- [ ] 登录态可改密：当前密码错误被拒绝；成功后当前会话保留、其他设备 401；有审计与通知邮件。
- [ ] 可改邮箱：新邮箱收到确认链接；确认后旧邮箱收到通知；占用/过期/重复使用均有明确错误；其他会话退出。
- [ ] 未配置 SMTP 时，改邮箱入口禁用并说明原因。

### 加密

- [ ] 重新生成恢复码后，新码可解锁、旧码失败、密码解锁不受影响、`data` 解密结果不变。
- [ ] 新增 crypto 单测覆盖错误密码、恢复码、rewrap、AAD/kind 混淆、篡改密文。
- [ ] 若实施 A4：关闭加密必须经显式端点、二次确认与审计；明示历史备份仍可能保留密文。

### 数据可恢复性

- [ ] 每次成功的 workspace PUT 产生一条历史；409 不产生。
- [ ] 历史按“每用户 20 份 / 30 天”清理；跨用户不可见；删除账号级联删除。
- [ ] 明文与加密文档都能列出版本、预览并恢复；恢复后 revision 继续递增。
- [ ] 恢复前本地自动保存一份快照。

### 审计与后台

- [ ] 审计接口仅管理员可用；支持分页、动作筛选；删除管理员后 `actor_email` 仍可追溯。
- [ ] 审计不包含密码、token、密文或用户内容。

### 缺陷与结构

- [ ] B1–B9 每项都有对应回归测试或明确的复现步骤。
- [ ] `go vet ./...`、`go test -race ./...`、`node --check`、`node --test` 全部通过；`web-tests/reliability.mjs` 在独立数据库上通过。
- [ ] 首屏 gzip 与 `/workspace` 重复拉取量有前后对比数据。
- [ ] `v0.1.0` 可从 tag 构建、镜像可拉取、`qingdh version` 正确。

## 8. 兼容边界与风险

- **数据格式**：不改变工作区 v2/v3 和 secret v4；新增迁移只加列/表，旧客户端不受影响。
- **迁移回滚**：现有 runner 只执行 Up，Down 段不会被自动执行。发布前必须备份，回滚以「镜像回滚 + 手工 Down」为准，文档写清楚。
- **会话语义**：改密默认保留当前会话、撤销其他会话；邮箱确认如果发生在没有该账号会话的设备上，则撤销全部会话（需重新登录）。这是本轮明确的产品决定，需写入 UI 文案。
- **历史回填**：`document_revisions` 只记录上线后的 PUT，不回填旧版本；当前文档读取与同步不受影响。
- **历史成本**：`document_revisions` 会放大写入量与数据库体积；保留策略必须先于功能上线，且要压测 20 份 × 512 KiB 的写放大。
- **关闭加密**：本轮默认不实现，避免打开降级面；若实施，必须单独评审威胁模型。
- **审计 PII**：`actor_email` 是账号标识快照，仅管理员可见，随 `audit_log` 一起按 365 天保留。
- **拆分风险**：`app.js` 拆分期间功能开关、懒加载 wiring、Service Worker 预缓存列表必须同步更新；每一步跑完现有回归再继续。
- **首屏目标**：C4 的目标是工程指标，不引入新的性能预算工具；以 gzip 体积和 DevTools 记录为准。

## 9. 开放问题

1. A4 关闭加密是否纳入本阶段？建议不纳入，先交付 A3。
2. A5 历史保留 20 份 / 30 天是否合适？若单用户文档长期接近 512 KiB，需要下调到 10 份或改为每日快照。
3. 改密后是否保留当前会话？建议保留；若希望“全部设备重新登录”，改为撤销全部会话并跳转登录。
4. A5 是否扩展到 memo secret 历史？建议下一轮再评估，本轮只做普通工作区。
5. 下一阶段是否接 AI 多供应商与搜索降级？建议在本阶段验收后单独开一轮。

## 10. 参考实现位置

| 关注点 | 位置 |
| --- | --- |
| 认证路由 | `internal/httpapi/server.go` |
| 会话与撤销 | `internal/auth/session.go`、`internal/store/sessions.go` |
| 密码与 token | `internal/auth/password.go`、`internal/auth/email.go` |
| 文档同步 | `internal/httpapi/workspace_handlers.go`、`internal/store/documents.go` |
| v3/v4 校验 | `internal/docval/validate.go`、`internal/docval/secrets.go` |
| 客户端加密 | `web/crypto.js`、`web/device-vault.js` |
| 设置 Hub | `web/index.html`、`web/app.js` |
| 审计 | `internal/httpapi/audit.go`、`internal/store/audit.go`、`migrations/0007_audit_log.sql` |
| 后台 | `web/admin.html`、`web/admin.js`、`internal/httpapi/admin_handlers.go` |
| 回归 | `web-tests/reliability.mjs`、`web-tests/unit/` |

## 11. 实施进度

> 本文只追加状态，不改写上面的计划正文。每项完成后更新对应行。

| 工作项 | 状态 | 验证 | 备注 |
| --- | --- | --- | --- |
| B1 限额保留策略 | 已完成 | `node --test web-tests/unit/core.test.mjs`（含 51 组/501 链接、公平配额、墓碑优先） | `enforceLimits` 抽到 `web/lib/core.js` |
| B2 自定义搜索引擎 | 已完成 | `web-tests/reliability.mjs`（新增自定义引擎后可从菜单选中） | `selectEngine` 改用 `allEngines()` |
| B3 自动同步开关 | 已完成 | `core.test.mjs` 表驱动 + `reliability.mjs`（关闭后编辑保持 dirty，手动同步上传） | `syncNow` 统一判断，用户操作走 `manual: true` |
| B4 对话框 resolver 并发 | 已完成 | `web-tests/unit/dialog.test.mjs`（重复调用结算旧值、不重复 showModal、可重开） | 新增 `web/lib/dialog.js`，解锁/导入解密/Passkey 统一使用 |
| B5 Service Worker 导航缓存 | 已完成 | `sw-policy.test.mjs`（仅 `/`、`/index.html`、`/ai` 可写入 shell） | 新增 `web/lib/sw-policy.js`，SW 通过 `importScripts` 复用 |
| B6 桌面侧栏 hidden 焦点 | 待开始 | | |
| B7 会话续期失败降级 | 待开始 | | |
| B8 workspace 缺失行自愈 | 待开始 | | |
| B9 安全默认 | 待开始 | | |
| A1 登录密码修改 | 待开始 | | |
| A2 邮箱修改 | 待开始 | | |
| A3 恢复码重新生成 | 待开始 | | |
| A4 关闭加密 | 待开始 | | 本轮实施（以任务提示词为准） |
| A5 服务端版本历史 | 待开始 | | |
| A6 审计日志后台 | 待开始 | | |
| A7 发布收口 | 待开始 | | 仅本地版本号、构建与文档；不推送 |
| C1 拆分 app.js | 待开始 | | |
| C2 补测试 | 待开始 | | |
| C3 同步效率 | 待开始 | | |
| C4 首屏瘦身 | 待开始 | | |
