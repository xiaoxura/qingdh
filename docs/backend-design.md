# 氢导航后端设计

> 状态：v1 与管理工作台已实现（2026-10）。实现与本文的差异见文末「实现说明」。
> 范围：A 方案——一个部署支持多个注册用户，每人一份私有导航数据；不登录仍可完整本地使用。
> 技术栈：Go + PostgreSQL，单二进制部署。
> 许可：MIT，Copyright (c) 2026 XiaoXuRa。
>
> 本文里的“v1”指后端第一阶段，“payload v2”指导航数据格式升级到可同步的版本。

## 1. 目标与非目标

### 目标

- 游客模式不依赖账号，数据仍然只在浏览器里。
- 邮箱 + 密码注册 / 登录 / 退出；SMTP 可用时支持邮箱验证和找回密码。
- 同一账号多设备同步一份导航文档。
- 游客数据在首次登录时由用户决定合并、覆盖或放弃。
- 单 Go 二进制内嵌前端，同源提供静态页和 API；一个 PostgreSQL 实例即可运行。
- 自托管体验优先：一个二进制 + 一个 `config.yml` 即可启动，不强制 Docker；备份/升级有文档。
- 开源，MIT；API 结构为以后加 OAuth / 客户端留好位置。

### 非目标（v1）

- 第三方 OAuth / OIDC / Passkey / 2FA（表结构预留，后续加）。
- 团队共享、公开主页、多文档 / workspace。
- 端到端加密（服务端可读，换来实现简单）。
- WebSocket / 实时协作。
- Redis、消息队列、微服务、多实例强一致限流。
- 多数据库方言支持（只做 PostgreSQL）。

## 2. 总体架构

```text
浏览器（静态页 + sync.js）
   │  HTTPS / JSON / Cookie Session
   ▼
Go 单二进制（chi + pgx）
   ├── 认证 / 会话 / 邮件 token
   ├── 文档同步（revision 乐观锁）
   ├── 静态资源（go:embed）
   └── SMTP
   │
   ▼
PostgreSQL 16
```

- 前端由 Go 二进制同源托管，Cookie、CSRF、CORS 都最简单；`file://` 只保留游客模式。
- 应用本身无状态：会话在数据库，文档在数据库。以后要多实例，直接加实例即可；限流会退化为单实例内存限流，需要时再换 Redis。
- 所有写操作走同一个 PostgreSQL，不做读写分离。

## 3. 技术选型

| 用途 | 选择 | 说明 |
| --- | --- | --- |
| 语言 | Go 1.23+ | 单二进制、`embed`、低资源 |
| 路由 | `net/http` ServeMux | Go 1.22+ 的方法与路径参数足够，无需额外依赖 |
| 数据库访问 | `pgx/v5` + 手写 SQL | 不用 ORM，不引入代码生成；SQL 集中在 `internal/store` |
| 迁移 | 内置 runner | SQL 文件 `embed`，按文件名顺序执行并记录在 `schema_migrations` |
| 日志 | `log/slog` | JSON 输出，请求 ID |
| 密码 | `x/crypto/argon2` | Argon2id，OWASP 推荐参数 |
| 邮件 | `wneessen/go-mail` | SMTP，支持 HTML / 纯文本 |
| 限流 | `x/time/rate` | 单实例内存版，按 IP / 邮箱 / 用户 |
| OAuth | `x/oauth2` + `go-oidc` | v2 再加，v1 不引入 |
| 静态资源 | `go:embed` | `web/` 下的前端文件；开发用 `web_dir` 覆盖 |

不建议在这个规模上引入 ORM、依赖注入框架、消息队列或 Kubernetes。

## 4. 目录结构

```text
qingdh/
├── cmd/qingdh/main.go          # 入口：serve / migrate / user 子命令
├── internal/
│   ├── config/                 # config.yml 解析与校验
│   ├── settings/               # 运行时设置（数据库 + 缓存）
│   ├── httpapi/                # 路由、中间件、handler
│   ├── auth/                   # 密码、会话、token、OAuth 预留
│   ├── store/                  # pgx 查询与事务封装
│   ├── mail/                   # SMTP 与邮件模板
│   └── docval/                 # payload 校验、限额
├── migrations/                 # SQL 迁移（embed）
├── web/                        # 前端与后台页面（go:embed 根目录）
│   ├── index.html / app.js / styles.css / boot.js
│   ├── admin.html / admin.css / admin.js
│   └── lib/core.js
├── assets.go                   # 嵌入入口（fs.Sub("web")）
├── docs/
├── Dockerfile
├── config.example.yml
└── README.md
```

## 5. 数据模型

一个人一份文档，不提前引入 workspace：

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,          -- 应用层统一 trim + 小写
  password_hash text,                  -- OAuth-only 用户可为空；v1 注册必填
  email_verified_at timestamptz,
  is_admin boolean NOT NULL DEFAULT false,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identities (              -- v2 OAuth 用，v1 不写入
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,              -- github / google / oidc:name
  subject text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE INDEX identities_user_id_idx ON identities (user_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL DEFAULT '',  -- 浏览器设备标识，来自 qingdh_device Cookie
  token_hash bytea NOT NULL UNIQUE,    -- 只存 SHA-256(token)
  user_agent text NOT NULL DEFAULT '',
  ip text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_renewed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
CREATE UNIQUE INDEX sessions_user_device_idx
  ON sessions (user_id, device_id) WHERE device_id <> '';

CREATE TABLE email_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('verify_email', 'reset_password')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user_kind_idx ON email_tokens (user_id, kind);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{"version":2,"settings":{},"groups":[]}'::jsonb,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- 注册时在同一事务里创建 `users` + 空 `documents`（revision 0）。
- 所有查询都以登录用户 id 为作用域，绝不接受客户端传入的 `user_id`。
- 以后要做共享空间，再加 `workspaces` / `workspace_members`，把 `documents` 的主键换成 `workspace_id`；v1 不做。
- 删除账号：级联删除 sessions / identities / email_tokens / documents。
- 过期会话清理：启动时 + 每天一次 `DELETE FROM sessions WHERE expires_at < now()`。

## 6. 同步数据格式（payload v2）

服务端不关心业务字段，只做最小校验；结构演进由前端 `version` 负责。

```json
{
  "version": 2,
  "settings": {
    "name": "",
    "engine": "bing",
    "updatedAt": 1760000000000
  },
  "groups": [
    {
      "id": "d3f0…",
      "name": "常用",
      "updatedAt": 1760000000000,
      "deletedAt": null,
      "links": [
        {
          "id": "8a1c…",
          "title": "GitHub",
          "url": "https://github.com/",
          "icon": "",
          "updatedAt": 1760000000000,
          "deletedAt": null
        }
      ]
    }
  ]
}
```

约定：

- `version: 2` 是同步格式；当前本地 v1 数据在实现同步时一次性迁移。
- 分组和链接都有 `updatedAt`；删除不直接移除，而是写 `deletedAt`（墓碑），保留 30 天后由客户端清理。
- 同步字段只包括导航数据、分组、链接，以及 `name` / `engine`。
  `theme`、`season`、`openInNewTab` 属于设备偏好，继续留在 `qingdh.prefs.v1`，不进入 payload。
- 限额：明文 payload ≤ 256 KiB，加密 envelope ≤ 512 KiB；≤ 50 个分组；≤ 500 个链接；标题 ≤ 40 字；分组名 ≤ 20 字；URL ≤ 2048 字符且只允许 `http` / `https`。
- 服务端校验：JSON 对象、`version` 受支持、`groups` 是数组、大小和数量限额、URL 协议。其余字段原样保存，避免前后端 schema 强耦合。
- 客户端遇到不认识的 `version` 时停止同步并提示升级，不要盲目覆盖。

### 6.1 加密 envelope（payload v3）

用户可选开启客户端加密。开启后 `documents.payload` 是 v3 envelope，服务端只校验外层结构和大小，无法校验内部分组/URL。

```json
{
  "version": 3,
  "encrypted": true,
  "kdf": "pbkdf2-sha256",
  "iterations": 600000,
  "salt": "base64",
  "wrappedKey": "base64(iv||ciphertext)",
  "check": "base64(iv||ciphertext)",
  "data": "base64(iv||ciphertext)",
  "recovery": { "wrappedKey": "base64(iv||ciphertext)" }
}
```

- AES-256-GCM；数据密钥随机生成，由 PBKDF2 密码密钥包裹；恢复码再包裹一份。
- 修改加密密码只更新 `salt` / `wrappedKey`，`data` 不变。
- 内层仍是 payload v2；客户端解密后再走原有合并逻辑。
- 管理员查看时由浏览器输入密码解密，密码不发送到服务端。
- 详细设计见 [encryption.md](encryption.md)。

## 7. API

统一前缀 `/api/v1`，JSON 请求/响应，Cookie 会话。错误格式：

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "云端数据已更新"
  }
}
```

`409` 额外带 `current`：

```json
{
  "error": { "code": "revision_conflict", "message": "云端数据已更新" },
  "current": { "revision": 7, "payload": { }, "updatedAt": "2026-10-28T03:20:00Z" }
}
```

### 7.1 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/register` | `{email, password}`；开启验证时发信不发会话，关闭时直接登录 |
| POST | `/auth/login` | `{email, password}`，创建会话 |
| POST | `/auth/logout` | 删除当前会话 |
| GET | `/auth/me` | 当前用户、验证状态 |
| POST | `/auth/verify-email` | `{token}`，验证邮箱并签发会话 |
| GET | `/auth/verify-email?token=` | 邮件链接入口，验证后 303 跳回首页 |
| POST | `/auth/refresh` | 手动续期当前会话（正常由中间件自动完成） |
| POST | `/auth/password` | `{currentPassword, newPassword}`；保留当前会话，撤销其他会话 |
| POST | `/auth/email-change` | `{password, newEmail}`；写 `pending_email`，向新邮箱发确认链接 |
| GET | `/change-email?token=` | 渲染确认页，不消费 token |
| POST | `/change-email` | 消费 token；换邮箱、撤销其他会话、通知旧邮箱 |
| POST | `/auth/resend-verification` | 重新发送验证邮件（限流） |
| POST | `/auth/forgot-password` | `{email}`，恒定返回 202 |
| POST | `/auth/reset-password` | `{token, password}`，重置并撤销全部会话 |
| GET | `/auth/sessions` | 当前账号的登录设备列表 |
| DELETE | `/auth/sessions/{id}` | 撤销指定会话 |
| POST | `/auth/logout-all` | 撤销除当前外的全部会话 |
| GET | `/admin/audit` | 审计分页与筛选（管理员，不返回密码/token/密文/用户内容） |
| DELETE | `/account` | `{password}`，删除账号及全部数据 |
| GET | `/account/export` | 导出导航 JSON（可选，前端也能本地导出） |
| GET | `/admin/overview` | 数据概览计数（管理员，不含任何文档/密钥内容） |
| GET | `/admin/settings` | 读取运行时设置（管理员） |
| PUT | `/admin/settings` | 修改运行时设置（管理员） |
| POST | `/admin/settings/test-email` | 发送测试邮件（管理员） |
| GET | `/admin/users` | 用户列表与搜索（管理员） |
| GET | `/admin/users/{id}/workspace` | 查看指定用户的导航数据（管理员） |
| PATCH | `/admin/users/{id}` | 设置管理员 / 禁用账号（管理员） |
| DELETE | `/admin/users/{id}` | 删除账号（管理员） |

### 7.2 同步

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/workspace` | `{revision, payload, updatedAt}` |
| PUT | `/workspace` | `{baseRevision, payload}`（payload v2 或 v3 envelope），成功返回新 revision |
| POST | `/workspace/disable-encryption` | `{baseRevision, currentPassword, payload}`；当前文档必须为 v3、payload 必须为 v2，成功后 revision+1 |
| GET | `/workspace/revisions` | 最近 20 份历史版本元数据 `{revision, size, createdAt}` |
| GET | `/workspace/revisions/{revision}` | 单个历史版本 `{revision, payload, size, createdAt}` |

`PUT` 的核心写入：

```sql
UPDATE documents
SET payload = $1, revision = revision + 1, updated_at = now()
WHERE user_id = $2 AND revision = $3
RETURNING revision, updated_at;
```

- 影响行数 1 → `200`；
- 影响行数 0 → 读取当前文档，返回 `409` + `current`；
- 文档不存在（理论不应发生）→ 用 revision 0 创建；
- 请求体超过限制 → `413`；
- 结构/URL 校验失败 → `422`。

### 7.3 其他

- `GET /healthz`：进程存活，不查库。
- `GET /readyz`：数据库 ping。
- 所有 API 响应 `Cache-Control: no-store`。

## 8. 认证与会话

### 8.1 注册 / 登录

- 邮箱 trim + 小写，唯一索引兜底并发注册。
- 密码 8–128 字符，不做复杂度组合要求；Argon2id 存储，参数按 OWASP 推荐并压测。
- 注册流程（管理后台要求邮箱验证且 SMTP 可用时）：创建账号 → 发送验证邮件 → 返回 `202`，**不签发会话**；用户点击邮件链接验证成功后，在服务端创建会话并设置 Cookie，再由 303 跳回首页。
- 关闭验证时：注册成功直接建立会话。
- 未验证账号登录：返回 `403 email_not_verified`，前端提供「重新发送验证邮件」。
- 登录统一失败提示「邮箱或密码不正确」；按 IP 和邮箱双维度限流。
- 登录成功后轮换 session，旧 session 删除。
- 会话：32 字节随机 token，Cookie 只保存原文；数据库只存 SHA-256。
- Cookie：`HttpOnly`、`SameSite=Lax`、`Path=/`；有效期随会话续期同步刷新。
  - HTTPS 请求（TLS 或受信任代理的 `X-Forwarded-Proto: https`）使用 `__Host-qingdh_session` + Secure；
    HTTP 请求降级为 `qingdh_session`。读取时两种名字都接受，切换协议不会掉登录。
  - 另有长期 `qingdh_device` Cookie（1 年）：同一浏览器再次登录时替换原有 session，而不是新增一条设备记录。
    登录时还会清理该用户历史遗留的旧 session（无 device_id），迁移时也会先合并一次。
- `last_seen_at` 最多每小时写一次，避免每个请求都更新。

### 8.2 会话自动续期

会话采用「滑动过期 + 绝对上限」，活跃使用不会掉登录：

```text
expires_at      = min(now + sessionIdleSeconds, created_at + sessionAbsoluteSeconds)
renew 条件       = now - last_renewed_at > sessionRenewSeconds（默认 1h）
renew 动作       = 延长 expires_at、刷新 Cookie Max-Age、更新 last_renewed_at
```

- 认证中间件每次命中有效会话时判断是否需要续期；续期最多每小时写一次库，避免每个请求都产生写放大。
- 续期**不轮换 token**，避免多标签页、并发请求和预加载请求互相把对方顶成 401。token 只在登录、改密、重置密码、主动退出时轮换或删除。
- `last_renewed_at` 与 `created_at` 决定绝对上限，超过 `SESSION_ABSOLUTE_TTL` 后即使一直活跃也必须重新登录。
- 前端监听 `401`：清理同步状态并提示重新登录，本地数据保留。不要把 401 当作网络错误无限重试。
- 已支持按设备生成独立 session、展示设备列表、单独踢下线（`GET/DELETE /auth/sessions`）。

续期写库语句：

```sql
UPDATE sessions
SET expires_at = $1, last_renewed_at = now(), last_seen_at = now()
WHERE id = $2
  AND expires_at > now()
  AND created_at + $3::interval > now()
  AND last_renewed_at < now() - $4::interval;
```

### 8.3 CSRF / CORS

- 同源部署，默认不返回 CORS 头。
- 所有非 GET 请求校验 `Origin`（无 Origin 时校验 `Referer`），并要求 `Content-Type: application/json`。
- 允许的来源：管理后台配置的站点地址，以及当前请求自身的 scheme://host。
  这样未设置站点地址时也能正常使用，设置了之后仍然只接受本机和正式地址。
- 配合 `SameSite=Lax`；不额外引入 CSRF token，除非以后加表单提交或跨站嵌入。
- 如将来前后端分域部署，再开 `ALLOWED_ORIGINS` 并显式处理 credentials。

### 8.4 邮箱验证 / 找回

- token 32 字节随机值，数据库只存 hash，单次使用。
- 验证 token 24 小时有效，单次使用；重置 token 30 分钟有效。
- 重发验证 / 找回邮件都限流；找回接口无论邮箱是否存在都返回 202，避免枚举。
- 重置成功撤销该用户全部会话，并发通知邮件。
- SMTP 未配置时：强制关闭验证要求并打印警告，找回密码不可用；提供 CLI `qingdh user passwd <email>` 兜底。
- 验证链接带 `Referrer-Policy: no-referrer`，避免 token 通过 Referer 外泄。

### 8.5 以后的 OAuth

- `identities` 表已预留；v1 不写。
- 回调流程：state + PKCE（OIDC）→ 按 `(provider, subject)` 找 identity → 没有则按已验证邮箱绑定 → 都没有则创建用户。
- 禁止仅凭未验证邮箱自动合并账号，避免账号被抢注。
- 所有登录方式最终都签发同一种 session，下游 handler 不需要区分来源。

## 9. 同步与合并

### 9.1 客户端状态

每个账号在本地维护：

```text
qingdh.data.v1:guest              # 游客数据
qingdh.data.v1:user:<uuid>        # 该账号的本地缓存
qingdh.sync.v1:user:<uuid>        # { revision, lastSyncedAt, dirty }
qingdh.prefs.v1                   # 明暗 / 风格等设备偏好
qingdh.backup.v1                  # 合并前快照
```

- 旧的 `qingdh.data.v1` 在接入同步时迁移为 guest key。
- 写入永远先写本地，再标记 `dirty`；页面立即可用。
- 同步状态：`synced / saving / offline / conflict / auth_required`。

### 9.2 触发

- 页面启动（已登录）；
- 窗口重新可见 / 获得焦点；
- `online` 事件；
- 本地编辑后 debounce 800ms；
- 设置里「立即同步」。

第一期不做 WebSocket；其他设备的变更靠聚焦时拉取，足够覆盖导航页的使用方式。

### 9.3 首次登录 / 换设备

登录后 `GET /workspace`：

1. **云端为空，本地有数据** → 上传本地数据（可给一次确认）；
2. **本地为空，云端有数据** → 拉取云端；
3. **两边都有** → 弹窗显示数量（本地 N 个 / 云端 M 个），三选一：
   - 合并（默认）；
   - 仅保留本地（覆盖云端）；
   - 仅保留云端（覆盖本地）；
4. 用户取消 → 保持纯本地状态，同步暂停；设置里可以重新发起；
5. 覆盖或合并前，本地存一份快照，可在设置里恢复。

### 9.4 合并算法

按 id 合并，同一项取 `updatedAt` 更新的一方：

- 只在一侧存在 → 保留；
- 两侧都存在 → 比较 `updatedAt`；相同时间以本机为准；
- 删除：`deletedAt` 更新的一方胜出，防止删除被另一台设备复活；
- 分组重名但 id 不同：按 id 保留两个分组，不自动合并；
- 分组内链接去重：合并后同组内按规范化 URL 去重，id 不同但 URL 相同只留一条；
- 设置：`name` / `engine` 按 `settings.updatedAt` 取新；设备偏好不参与；
- 排序：本机顺序优先，云端独有的项目追加到末尾。

墓碑保留 30 天；一次成功同步后，客户端清理超过 30 天的墓碑。

### 9.5 409 冲突

`PUT` 返回 409 时，本地也可能有未推送的修改。弹窗同样提供「合并 / 仅本机 / 仅云端」，默认合并。

- 合并 → 用 409 返回的云端数据 + 本地数据计算，再以 `current.revision` 为 base 重试；
- 仅本机 → 以 `current.revision` 为 base 直接 PUT；
- 仅云端 → 用 `current` 覆盖本地；
- 连续冲突 → 停止自动重试，保留弹窗，避免死循环。

为了减少打断，可以在弹窗里加「以后自动合并」选项；默认仍然是询问。

### 9.6 失败与重试

| 状态 | 处理 |
| --- | --- |
| 401 | 暂停同步，提示重新登录；本地数据保留 |
| 403 | 权限/账号禁用，停止同步 |
| 409 | 合并弹窗 |
| 413 / 422 | 显示错误，不重试 |
| 429 | 读取 `Retry-After`，退避 |
| 5xx / 网络错误 | 指数退避 + 抖动，最长 60 秒 |
| 离线 | 标记 offline，恢复网络后先拉再推 |

### 9.7 多标签

- `BroadcastChannel('qingdh')` 通知数据变更和同步状态。
- 支持 Web Locks 时，用 `navigator.locks` 选一个标签执行同步；不支持的浏览器退化为各标签自行同步，409 时按合并处理。
- 所有标签共享同一份 localStorage 数据；写前重新读取，避免互相覆盖。

### 9.8 退出登录

- 撤销当前会话，切回 guest key 的本地数据。
- 云端数据不动；本机账号缓存保留（按 user id 隔离），设置里提供「清除本机缓存」。
- 如果还有未同步的本地修改，退出前提示。

## 10. 安全与隐私

- 全站 HTTPS；HSTS；严格 CSP，不加载第三方脚本。
- 密码 Argon2id；登录/注册/找回/发信全部限流。
- 会话只存 token hash；Cookie 不暴露给 JS。
- 所有 SQL 参数化（pgx 占位符）；payload 限额和 URL 协议校验。
- 请求体大小限制、读写超时、优雅关闭。
- 反向代理场景只信任 `server.trusted_proxies` 中的地址传来的 `X-Forwarded-For`。
- 日志脱敏：不记录密码、token、Cookie；邮箱可哈希或只记 id。
- 账号删除级联清理；提供导出。
- 不做 E2EE：服务端可读数据，便于合并、备份和找回。README/隐私政策写清楚；托管版要说明数据存放位置和删除方式。
- 备份文件加密存储；恢复流程写进文档并实际演练。

## 11. 配置

### 11.1 config.yml（仅启动必需项）

```yaml
server:
  listen: ":8080"
  trusted_proxies: ["172.16.0.0/12"]
database:
  host: "127.0.0.1"
  port: 5432
  user: "qingdh"
  password: "secret"
  name: "qingdh"
  sslmode: "prefer"
  max_conns: 10
  migrate_on_start: true
log_level: "info"
web_dir: ""
```

- 配置文件通过 `-config` 指定，默认 `./config.yml`，也可用 `QINGDH_CONFIG`。
- 数据库使用独立字段，服务端在运行时拼装 DSN，密码可以包含特殊字符。
- `sslmode` 取值：`disable` / `allow` / `prefer` / `require` / `verify-ca` / `verify-full`。
- 配置里的相对 `web_dir` 相对于配置文件所在目录解析。
- 文件包含数据库密码，建议 `chmod 600`，并加入 `.gitignore`。

### 11.2 运行时设置（数据库 + 管理后台）

以下内容不在 `config.yml` 中，保存在 `settings` 表，由 `/admin` 修改：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | 空 | 站点对外地址；留空按请求自动识别 |
| `allowRegistration` | `true` | 关闭后只能由 CLI 建号 |
| `requireEmailVerification` | `true` | 无 SMTP 时自动失效 |
| `smtpHost` / `smtpPort` / `smtpUsername` / `smtpPassword` / `smtpFrom` / `smtpTls` | 空 / `587` / `auto` | 邮件发送 |
| `sessionIdleSeconds` | 14 天 | 闲置过期 |
| `sessionAbsoluteSeconds` | 180 天 | 绝对上限 |
| `sessionRenewSeconds` | 1 小时 | 续期最小间隔 |

- 单实例内存缓存，保存后立即生效；多实例每 30 秒重新加载一次。
- 校验失败不会覆盖旧值，也不会让服务无法启动。

### 11.3 管理员

- `users.is_admin` 标记管理员；`GET /api/v1/admin/*` 需要管理员会话。
- 首个管理员通过 CLI 创建：`qingdh user create <email>` + `qingdh admin grant <email>`。
- 管理员不能取消自己的权限，也不能禁用或删除自己。
- 管理后台可以查看任意用户的分组和链接（只读），用于排查同步问题或协助恢复数据。
- 被禁用的账号：现有会话立即失效，重新登录返回 `403 account_disabled`。

## 12. 部署与运维

- 主要方式：`config.yml` + Go 二进制直接运行，不依赖 Docker。
- 可选多阶段 Dockerfile：`golang` 构建 → `distroless/static` 运行，非 root，内嵌前端；挂载 `/etc/qingdh/config.yml`。
- 迁移：`qingdh migrate` 作为独立步骤；也支持启动时自动迁移，用 `pg_advisory_lock` 防止并发。
- 备份：每天 `pg_dump -Fc`，保留 7/30 天；文档写清恢复命令。
- 健康检查：`/healthz`、`/readyz`。
- 升级：拉新镜像 → 迁移 → 重启；迁移只做向前兼容的变更。
- 日志：slog JSON，含 request id、user id（不记邮箱时用 id）。
- 开发：本地 PostgreSQL + `web_dir: "web"` 的 `config.yml`，`go run ./cmd/qingdh serve -config config.yml`。

## 13. 测试

- 单元测试：URL/邮箱校验、密码 hash、token 生成与 hash、合并算法（表驱动，覆盖新增/修改/删除/墓碑/时钟相同）。
- 集成测试：`httptest` + 测试 PostgreSQL（testcontainers 或 CI service）；覆盖注册、登录、401、409、413、422、级联删除。
- 并发测试：两个客户端同 baseRevision 同时 PUT，只能一个成功。
- 前端 E2E（可选）：游客→登录合并、409 弹窗、离线恢复。
- CI：`go vet`、`staticcheck`、`govulncheck`、`go test -race`、构建镜像。

## 14. 实施顺序

1. **基础**：config、migrations、health、Docker、静态资源 embed。
2. **认证**：注册/登录/退出/me、会话表与自动续期、Cookie、限流、CSRF。
3. **同步**：documents、GET/PUT、revision 冲突、前端 sync 模块。
4. **游客合并**：登录前本地数据、数量弹窗、合并/覆盖/快照。
5. **邮件**：注册验证（含开关）、找回、SMTP、CLI 兜底。
6. **账号管理**：设备列表、退出所有设备、导出、删号。
7. **打磨**：离线队列、多标签、同步状态、文档、备份脚本。

v1 完成后，再评估 OAuth / OIDC；共享空间、E2EE、实时同步都不在近期范围。

## 15. 当前默认值（可调整）

- 密码最短 8 位；不做复杂度组合要求。
- 注册开放；托管实例可关注册或加邀请码。
- 开启邮箱验证时，未验证账号不能登录；验证成功即签发新会话。验证开关在管理后台修改，默认开启。
- 会话采用滑动过期：闲置 14 天失效，活跃时自动续期（最多每小时一次），绝对上限 180 天。续期只延长有效期、不轮换 token，避免多标签/并发请求互相顶掉；登录、改密、重置密码时轮换。
- 合并询问为主，不默认静默覆盖。
- 主题 / 风格 / 打开方式按设备本地保存，不参与同步。

## 16. 前端改造清单

- 新增登录 / 注册 / 账号设置弹窗。
- 新增同步状态指示（页脚）和「立即同步」。
- 数据模型升级到 payload v2：`updatedAt` / `deletedAt`、迁移旧数据。
- 本地存储按 guest / user id 分键。
- 首次登录合并弹窗、409 冲突弹窗、合并前快照。
- API client：Cookie 请求、401/409/429 处理、离线队列。
- 现有主题偏好继续走 `qingdh.prefs.v1`，不进同步。


## 17. 实现说明（v1）

实际落地的版本在以下几个细节上与草案不同，均已在代码中注明：

- **路由**：使用 `net/http` 的 `ServeMux`（Go 1.22+ 方法路由与路径参数），没有引入 chi。
- **迁移**：自带的轻量 runner，读取 `-- +goose Up` 段落，使用 `pg_advisory_lock` 防止并发迁移；没有引入 goose 依赖。
- **查询**：pgx 手写 SQL，没有 sqlc 代码生成；贡献者不需要额外工具链。
- **注册即验证的例外**：当管理后台关闭邮箱验证（或未配置 SMTP）时，注册会把 `email_verified_at` 直接写成当前时间，账号 UI 显示「邮箱已验证」。
- **验证链接**：`GET /verify-email?token=` 验证成功后签发会话并 303 跳转 `/?verified=1`；重置链接跳到 `/?reset_token=`，由前端弹窗完成设置。
- **会话续期**：中间件在每次命中时检查 `last_renewed_at`，超过 `SESSION_RENEW_AFTER` 才写库并刷新 Cookie；不轮换 token。
- **静态资源**：前端和管理后台页面集中在 `web/`，由根包 `assets` 通过 `go:embed web` 打包；`Files` 以 `web/` 为根，公开 URL 仍是 `/app.js`、`/admin`；开发时 `web_dir` 从磁盘读取。
- **配置拆分**：启动配置迁移到 `config.yml`（YAML，数据库使用 host/port/user/password/name 独立字段），运行期设置迁移到 `settings` 表 + `/admin`；对应新增迁移 `0002_admin_settings.sql`。
- **站点地址**：`baseUrl` 属于运行时设置；为空时 CSRF 校验、邮件链接和 Cookie 安全属性都从当前请求推导，设置了则以配置值为准（同时仍接受请求自身来源，避免把自己锁在后台外）。
- **管理后台**：`admin.html` / `admin.css` / `admin.js` 是独立页面，复用同一会话 Cookie 和管理 API；权限在服务端校验。
- **设备识别**：`0003_session_device.sql` 增加 `sessions.device_id` 和唯一索引；`qingdh_device` 长期 Cookie 让同一浏览器重复登录复用一条会话，迁移会先合并旧重复记录。
- **客户端加密**：`crypto.js` 实现 PBKDF2 + AES-GCM、dataKey 包裹和恢复码；`docval` 接受 v3 envelope；管理后台在浏览器内解锁查看。
- **动态生效**：注册、验证、SMTP、会话时长每次从 `settings` 缓存读取；管理后台保存后立即生效，多实例 30 秒内收敛。
- **安全头**：CSP 为 `script-src 'self'`，因此首屏主题脚本拆到了 `boot.js`，避免内联脚本。
- **限流**：单实例内存实现（`golang.org/x/time/rate`），多实例部署时限流按实例计算，需要时再换 Redis。
- **测试**：集成测试使用 embedded-postgres 启动临时数据库，也可以通过 `TEST_DATABASE_URL` 复用外部数据库。

## 18. 下一轮扩展：v4 secret 与 AI 代理（已实现）

### 18.1 数据表

`0004_user_secrets.sql`：

```sql
CREATE TABLE user_secrets (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('ai', 'memo', 'privacy')),
    payload jsonb NOT NULL,
    revision bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind)
);
```

- 只存 v4 密文；服务端不能校验内部 AI 供应商、备忘录字段或隐私内容；
- 管理后台不查询该表，也没有 secret 读取接口；
- 每个 kind 独立 revision；删除账号时级联删除。

### 18.2 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/site` | 公开站点名称与 Logo，不含任何管理配置 |
| GET | `/ai` | 服务端返回 SPA shell，由前端渲染独立的 AI 搜索结果页 |
| GET | `/api/v1/secrets/{kind}` | `{revision, payload, updatedAt}`；kind 白名单，缺失返回 revision 0 |
| PUT | `/api/v1/secrets/{kind}` | `{baseRevision, payload}`；409 返回 `current` |
| DELETE | `/api/v1/secrets/{kind}` | 删除该 kind 的云端密文（用于关闭主加密前清理 ai/memo） |
| POST | `/api/v1/ai/chat` | 代理调用；密钥仅本次请求；SSE 流式 |
| POST | `/api/v1/ai/test` | 可选，用最小请求测试供应商连接 |
| POST | `/api/v1/ai/models` | 用用户 Key 读取供应商模型列表，不落库 |
| POST | `/api/v1/ai/balance` | 用用户 Key 查询供应商余额，不落库 |
| GET | `/api/v1/ai/usage` | 当前用户最近 30 天调用汇总与最近记录 |

- `/api/v1/admin/settings` 新增 `siteName`、`siteLogo`；公开的 `/api/v1/site` 只返回这两项，供首页/后台品牌渲染；
- `kind` 只接受 `ai`、`memo`、`privacy`，其余按 404 处理；
- secret 写入限流 120 次/分钟（burst 30）；
- AI 代理限流 10 次/分钟（burst 5），另按用户每日额度；
- 全部要求登录会话，沿用 Origin/Referer + JSON 校验。

### 18.3 docval v4

- 校验 `version=4`、`encrypted=true`、`kind` 白名单、`cipher=aes-256-gcm`；
- `keySource` 与 kind 必须匹配：`ai/memo → data-key`、`privacy → password`；
- `data-key` envelope 不允许出现 `kdf/salt/wrappedKey/check/recovery` 字段；
- `password` envelope 需要 PBKDF2 参数、salt、wrappedKey、check、recovery，并校验 Base64 长度与总大小；
- 拒绝 kind 互换、v3 或明文 payload；
- 总大小：memo/privacy ≤512 KiB，AI 配置 ≤64 KiB。

### 18.4 AI 代理

- 服务端 allowlist 只包含固定供应商（当前 DeepSeek）；DeepSeek 允许 `/models` 返回的安全模型标识，其他供应商仍使用固定模型 allowlist；
- DeepSeek 先调用固定上游 `https://api.deepseek.com/v1/tools/search`（query 截断到 128 字符、count 5、不取正文），把结构化结果作为不可信资料交给对话模型，并通过 SSE `sources` 事件下发；`/api/v1/ai/test` 对这类供应商测试 Search 接口；
- `POST /api/v1/ai/models` 代理 `GET https://api.deepseek.com/models`，`POST /api/v1/ai/balance` 代理 `GET https://api.deepseek.com/user/balance`；两者都只使用单次请求内的 Key，不缓存余额或模型；
- `GET /api/v1/ai/usage` 读取 `ai_usage` 表，只包含供应商/模型、调用类型、状态、Token、耗时，不保存 prompt、回答或 Key；DeepSeek 的对话请求会开启 `stream_options.include_usage` 以取得 Token 数；
- 不接受客户端传入的 `baseUrl`，上游地址不参与拼接；
- 请求：`{provider, model, apiKey, query, history, maxTokens}`；历史只允许 user/assistant，≤10 条；
- 响应：`text/event-stream`，事件为 `ready` / `delta` / `sources` / `done` / `error`；
- 超时 60 秒，客户端中止时通过 request context 取消上游；
- 不记录请求体、响应体、API Key；上游错误统一映射为 `upstream_*` 脱敏错误。
- AI 调用元数据写入 `ai_usage`（provider/model/kind/status/token/耗时），不含 prompt、回答或 Key；用户删除时级联清理；`chat/test/models/balance` 都是独立记录，30 天聚合用于页面展示。

### 18.5 运行时设置

新增 `aiDailyLimit`（默认 200，1–10000），在 `/admin` 的会话卡片下调整。与现有设置一样保存在 `settings` 表，内存缓存，多实例 30 秒内收敛。

### 18.6 实现说明

- 前端新增 `device-vault.js`（IndexedDB vault）、`secrets.js`（secret 同步）、`memo.js`、`ai.js`、`privacy.js`、`command-palette.js`、`bookmarks.js`、`pwa.js`、`passkey.js`；
- `go:embed web` 打包这些文件、`manifest.webmanifest`、`service-worker.js` 与 `assets/` 图标；
- CSP 增加 `worker-src 'self'`、`manifest-src 'self'`，`connect-src` 允许 HTTPS 以支持 AI 浏览器直连；
- `statusRecorder` 增加 `Unwrap()`，让 SSE 经日志中间件后仍可 Flush。

## 19. 可靠性与安全边界加固（2026-10-29）

- **迁移锁**：`Store.Migrate` 独占一条池连接执行 `pg_advisory_lock` / 迁移 / `pg_advisory_unlock`，避免会话级锁跨连接泄漏。
- **可信 Host**：`server.trusted_hosts` 配置非空时，中间件拒绝其他 Host；`baseURLFor` 在未设置站点地址时只使用可信 Host 生成邮件链接。
- **改密原子化**：`Store.UpdatePasswordAndRevokeSessions` 在单事务中更新密码并删除全部会话；HTTP 重置密码和 CLI `user passwd` 都走该方法。
- **会话绝对期限**：`SessionManager.Authenticate` 每次按当前设置检查 `created_at + absolute`，超期立即删除会话并返回未认证，因此缩短上限会即时生效。
- **PWA 缓存**：service worker 对 app shell 网络优先、离线回退；缓存名随发布递增，新版本 `waiting` 到用户确认后再 `SKIP_WAITING`。
- 前端保存代次、会话代次与生命周期代次见 [reliability.md](reliability.md)。
