# 导航数据加密设计

> 状态：已实现（2026-10）。用户可选开启，云端只存密文；服务端、备份和管理员默认都看不到分组和链接。

## 1. 威胁模型

能防：

- 数据库、备份、对象存储泄露；
- 运维/管理员直接查 JSONB；
- 管理员日常翻看用户书签。

不能防：

- 恶意服务端篡改前端 JS 来偷密码（网页端 E2EE 的固有限制）；
- XSS 或用户设备被控制；
- 用户主动把加密密码/恢复码交给别人；
- 弱密码被拿到密文后离线暴力破解。

这里的目标是「诚实但好奇的服务端」和「备份泄露」，不是「连服务端也不信任」的严格零知识。

## 2. 密钥结构

```text
dataKey          = 32 字节随机数，真正加密导航数据
kek              = PBKDF2-SHA256(password, salt, 600000) -> AES-256
wrappedKey       = AES-GCM(kek, dataKey)
recoveryKey      = SHA-256("qingdh-recovery-v1:" + recoveryCode)
recoveryWrapped  = AES-GCM(recoveryKey, dataKey)
check            = AES-GCM(dataKey, "qingdh-check-v1")
data             = AES-GCM(dataKey, JSON.stringify(payload v2))
```

- 修改加密密码只重新包裹 `dataKey`，**不重新加密全部链接**。
- 恢复码是 20 字节随机数的 40 位十六进制，只在开启加密时展示一次。
- 密码不落库，服务端没有可逆或不可逆的密码副本；`check` 用于客户端快速判断密码是否正确。
- PBKDF2 的参数写在 envelope 里，后续可以平滑升级到 Argon2id。

## 3. Envelope（payload version 3）

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

- 服务端只校验 envelope 结构、Base64 和大小，无法校验内部分组/URL。
- 一旦文档变成 v3，服务端会拒绝后续的 v2 明文覆盖（`422 encryption_required`），防止旧客户端或旧标签页把密文降级成明文。
- 内层仍是现有 payload v2，客户端解密后再走原有合并/校验逻辑。
- 文档上限提升到 512 KiB（Base64 膨胀后仍有余量）。

## 4. 流程

### 开启加密（可选）

1. 用户设置加密密码并确认；
2. 客户端生成 `dataKey`，加密当前明文 payload；
3. 展示恢复码，用户确认已离线保存；
4. 用当前 revision 上传 envelope；
5. 之后所有上传都携带密文。

### 新设备 / 刷新

1. 账号密码登录；
2. 拉取到 v3 envelope；
3. 优先尝试 `sessionStorage` 中本标签页缓存的 `dataKey`；
4. 没有缓存则弹窗输入加密密码（或恢复码）；
5. 解出 payload 后才允许合并、上传；
6. 解锁失败不能覆盖云端。

### 修改加密密码

1. 输入旧密码（或恢复码）；
2. 解出 `dataKey`；
3. 用新密码和新 salt 重新包裹；
4. 只更新 envelope 的 `salt` / `wrappedKey`，`data` 不变；
5. 用当前 revision 上传。

### 后台排障

- 管理员打开用户数据时，如果看到 v3 envelope，弹窗要求输入用户提供的加密密码；
- 密码只在管理员浏览器内派生密钥，不发送到服务端；
- 解密后复用现有分组/链接渲染；
- 建议后续补审计日志，记录“管理员查看了哪个用户的数据”。

### 导出 / 导入

- 开启加密后，导出文件直接是 v3 envelope；
- 导入时识别 v3，提示输入密码或恢复码，解密后再走原导入合并；
- 明文 JSON 仍然兼容（未开启加密的用户）。

## 5. 取舍与限制

- 忘记加密密码且丢失恢复码 = 云端数据无法恢复。删除账号/重新开始是唯一选择。
- 本地浏览器存储仍保留明文（为了离线可用）；加密保护的是云端与备份。共用电脑需自行清理浏览器数据。
- 解锁后的 `dataKey` 放在 `sessionStorage`，只在本标签页生命周期内有效；关闭标签页或退出登录即清除。
- 需要安全上下文（HTTPS 或 localhost）才有 `crypto.subtle`；纯 HTTP 局域网地址无法使用。
- 管理后台前端由服务端提供，因此不能防御恶意服务端替换 JS。

## 6. 已实现范围

1. Envelope 校验、crypto 模块、后端测试；
2. 开启加密/解锁/恢复码 UI；
3. 同步上传下载改造；
4. 后台解密查看；
5. 修改密码（密码或恢复码）、导出/导入；
6. 文档与端到端验证。

仍未做：


- 强制所有用户迁移到加密模式。

已完成（2026-10-29）：

- 重新生成恢复码（只替换 `recovery.wrappedKey`，旧码立即失效）；
- 关闭加密（显式端点 + 登录密码二次确认，见第 13 节）。

## 7. Secret envelope v4（AI / 备忘录 / 隐私空间）

工作区继续使用 v3 envelope，不强行迁移。新增云端内容使用独立的 v4 secret：

```json
{
  "version": 4,
  "kind": "ai | memo | privacy",
  "encrypted": true,
  "keySource": "data-key | password",
  "cipher": "aes-256-gcm",
  "data": "base64(iv||ciphertext)"
}
```

- `kind=ai/memo`：`keySource=data-key`。用主 `dataKey` 经 HKDF-SHA256 派生用途子密钥：
  `info = "qingdh:v4:<kind>:key"`，AAD = `"qingdh:v4:<kind>:data"`。
  不再次 PBKDF2，所以 Device Vault 解锁后可无感同步。
- `kind=privacy`：`keySource=password`，额外包含 `kdf`、`iterations`、`salt`、`wrappedKey`、`check`、`recovery.wrappedKey`。
  AAD 分别使用 `qingdh:v4:privacy:wrap/check/data/recovery`，与主 dataKey 完全隔离。
- 子密钥和用途 AAD 防止密文互换：把 memo 密文塞进 AI 配置、或把 AI 密文当作 memo，都会解密失败。
- 服务端 `docval` 只校验 kind 白名单、`keySource` 与字段组合、Base64 长度和总大小，不解析内部 JSON。
- 每个 kind 有独立 revision；memo 修改不会推高导航文档 revision。

## 8. Device Vault（本机记住解锁）

- 每台浏览器在 IndexedDB（`qingdh.vault.v1`）生成一个 `extractable: false` 的 AES-GCM `deviceKey`；
- 用 `deviceKey` 包裹主 `dataKey`，保存 `{userId, envelopeId, iv, wrappedDataKey, createdAt}`；
- `envelopeId` 由 envelope 的 `check` 计算 SHA-256 指纹：修改加密密码只 rewrap、`check` 不变，vault 继续有效；如果将来重建 dataKey，指纹变化，旧 vault 自动失效并删除；
- 解锁时优先使用本标签页 `sessionStorage`，其次 Device Vault，最后才弹密码；
- 首次解锁默认勾选“记住此设备”；退出登录或“忘记此设备”会立即删除 IndexedDB 记录和内存密钥；
- 不保存密码、明文 dataKey，也不把 dataKey 写入 URL、日志或 `localStorage`；
- 安全边界：拿到“已登录浏览器配置”的人可以直接解密；它防的是服务端/备份泄露和普通旁观，不防设备被入侵、恶意扩展、键盘记录器。

## 9. Passkey（H1 本地门禁）

- 用系统平台认证器（Touch ID / Windows Hello / Android 生物识别）作为 Device Vault 的额外门禁；
- `credentialId`、SPKI 公钥和签名计数器只保存在 IndexedDB（`qingdh.passkey.v1`），不新增服务端表，也不改变同步协议；
- 解锁时由浏览器完成 WebAuthn 断言，页面再本地校验：
  - `clientDataJSON` 的 type / challenge / origin；
  - `rpIdHash`、UP/UV 标志、signCount；
  - ECDSA P-256（DER → raw r||s）或 RSA 签名；
- 验证成功后只在内存中放行 5 分钟的 vault gate；刷新页面后需要重新验证；
- 取消、验证失败或浏览器不支持时始终回退加密密码；
- H2（服务端可信设备注册、列表、远程撤销）仍是可选项，本轮未实现。

## 10. 隐私空间

- 独立隐私密码、独立随机 `dataKey`、独立恢复码；创建时必须保存恢复码一次；
- 整份隐私工作区（私密分组/链接 + 私密备忘录）作为 `kind=privacy` 的 v4 密文上传；
- 不写入 Device Vault，也不使用 Passkey；每次进入都验证密码；
- 空闲 3 分钟、标签页隐藏 30 秒或手动点击“锁定”时，清空 DOM、内存密钥和本页复制过的剪贴板内容；
- 通过恢复码可以重置隐私密码（只 rewrap 隐私 dataKey，不重新加密内容）；
- 忘记隐私密码且丢失恢复码 = 隐私空间不可恢复；普通工作区不受影响；
- 页面标题始终是“氢导航”，隐私内容不进入普通搜索、导出、命令面板索引或管理后台。

## 11. AI 密钥与服务端代理

- AI 配置和 API Key 作为 `kind=ai` 的 v4 密文同步；UI 永不回显完整 Key，编辑时留空表示保持原值；
- **服务端代理**：浏览器把本次请求密钥发给氢导航服务端，服务端在内存中短暂可见。服务端不落库、不记录请求体/响应体/Authorization，错误信息统一脱敏，并按 provider allowlist 选择固定上游地址（禁止任意 URL，防 SSRF）；
- **浏览器直连**：支持 CORS 的 OpenAI 兼容接口可由客户端直接请求，密钥不经过氢导航服务端，但会出现在浏览器网络面板，并受扩展/恶意脚本威胁；
- **URL 跳转**：网页型供应商不需要密钥，查询直接带到供应商网页（当前秘塔作为搜索引擎接入，AI 网页型后续再接入）；
- AI 历史默认不持久化；本轮只保留当前页面会话内的上下文，不上传服务端；
- 限额：查询 ≤2000 字符、历史 ≤10 条、每用户 10 次/分钟、每日额度由管理后台配置（默认 200）；上游超时 60 秒，可中止。

## 12. 已实现范围（2026-10 下一轮）

1. v4 secret envelope、HKDF 子密钥、用途 AAD 与服务端 docval；
2. `user_secrets` 表、GET/PUT API、revision 冲突；
3. Device Vault（IndexedDB、记住/忘记、退出清除）；
4. Passkey H1 本地门禁与密码回退；
5. 备忘录（未登录/未加密时使用 IndexedDB 本机密钥加密；开启主加密后以 v4 密文同步，支持 Markdown/任务/标签/提醒/双链/导出/冲突合并）；
6. AI provider registry、配置加密、URL 跳转、服务端流式代理、限额与脱敏；
7. 隐私空间（独立密码/恢复码、私密链接与备忘录、快捷键、自动锁定、DOM 清理）；
8. 侧栏、编辑式时钟、命令面板、PWA/书签导入。

仍未做：

- Passkey H2（服务端可信设备、远程撤销）；

- 服务端全文搜索/多端实时同步；
- 文件/图片附件与多人协作。

## 13. 关闭加密（2026-10-29）

- 入口：`POST /api/v1/workspace/disable-encryption`，请求体 `{ baseRevision, currentPassword, payload }`；`PUT /workspace` 仍然拒绝 v3 → v2 明文覆盖。
- 服务端要求：登录会话、当前登录密码、当前文档为 v3、`baseRevision` 匹配、`payload` 为合法 v2；成功后 revision+1 并写审计 `account.encryption_disabled`。
- 密钥依赖：`kind=ai/memo` 使用主 `dataKey` 派生的子密钥，存在时返回 `409 encryption_dependency` 并列出 kind；用户导出后可通过 `DELETE /api/v1/secrets/{kind}` 显式删除，再重试关闭。隐私空间用独立密码/密钥，不阻止关闭。
- 客户端：二次确认并提示“历史版本、历史备份和已删除数据中的旧密文不会自动清理”；成功后清除本标签页 `sessionStorage` 的 dataKey、Device Vault 记录与 Passkey，重置 cryptoState，保留本地明文缓存，并用 `BroadcastChannel('qingdh')` 的 `encryption-disabled` 消息让其他标签页退回明文。
- 边界：关闭后服务端、数据库与之后的备份都能读取导航文档；旧备份、旧 revision 与墓碑中的密文仍可能被恢复，需要用户自行处置。
