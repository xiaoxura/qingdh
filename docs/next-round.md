# 氢导航 · 下一轮开发规划

> 状态：主线 A–E 与扩展 F/G/I/J/H1 已实现（2026-10-28），差异见 §16
> 范围：AI 搜索、加密密钥存储、备忘录、隐私空间、侧栏布局、时钟视觉
> 原则：先补加密与数据边界，再做功能；所有新增云端内容默认按“服务端不可读”设计。

## 1. 目标

下一轮希望把氢导航从“可同步的起始页”推进到“个人入口 + 私密工作区”：

1. **AI 搜索**：支持秘塔 AI、DeepSeek 搜索 API 等；能免密钥直达的走 URL，需要密钥的由用户自备，密钥加密后同步。
2. **设备自动解锁**：同一账号在多台设备上各自完成一次解锁后，日常上传/下载不再反复输入加密密码。
3. **备忘录**：独立的加密备忘录空间，服务端和管理员看不到内容。
4. **隐私空间**：通过指定快捷键进入，独立密码验证，内容不进入普通工作区。
5. **侧栏化**：把底部功能区整合到可隐藏侧栏，减少首页视觉噪音。
6. **时钟优化**：重新设计首页时间/日期/问候的排版和动效。

### 1.1 已确认决策

以下四项按规划建议定稿，不再作为开放问题：

- **备忘录与 AI 云端能力强制开启主加密**；未开启主加密时只允许本地临时数据或不提供该能力。
- **Device Vault 默认开启“记住此设备”**；首次解锁默认勾选，退出登录默认清除本机 vault。
- **隐私空间 MVP 范围为私密分组/链接 + 私密备忘录**；暂不纳入 AI 密钥和文件附件。
- **侧栏放左侧，时钟默认采用编辑式排版**；时钟仍保留极简样式和显示秒等设备偏好。

## 2. 设计原则

- **客户端加密优先**：新增的 AI 密钥、备忘录、隐私数据都以密文上传；服务端只做结构校验、限额和同步。
- **密钥分级**：主数据密钥、各 secret 的子密钥、隐私空间独立密钥分开，避免一个功能泄露全部数据。
- **明示安全边界**：设备自动解锁会降低“设备被盗”时的保护；不把它宣传成零知识或绝对安全。
- **不破坏现有数据**：v2 明文和 v3 加密工作区继续可读；新增能力使用独立 v4 secret，不强行迁移旧数据。
- **功能可关闭**：侧栏、自动解锁、AI、备忘录、隐私空间都可以独立关闭；关闭后不影响基础起始页。
- **零前端依赖**：继续使用原生 JS / CSS / WebCrypto，不引入框架和构建步骤。

## 3. 能力地图

| 能力 | 数据位置 | 加密 | 管理员可见 | 依赖 |
| --- | --- | --- | --- | --- |
| 现有分组/链接 | `documents.payload` v3 | 主 dataKey | 密文，需用户密码 | 已有 |
| AI 供应商配置 | `user_secrets(kind='ai')` | 主 dataKey 派生子密钥 | 否 | 主加密、设备解锁 |
| 备忘录 | `user_secrets(kind='memo')` | 主 dataKey 派生子密钥 | 否 | 主加密、设备解锁 |
| 隐私空间 | `user_secrets(kind='privacy')` | 独立密码 + 独立 dataKey | 否 | 独立密码、恢复码 |
| AI 请求代理 | 不持久化 | TLS 传输；密钥仅内存 | 请求期间可见 | AI 配置 |
| AI 密钥 | `user_secrets(kind='ai')` | 同 AI 配置 | 否 | 主加密 |
| 设备信任 | 浏览器 IndexedDB | 设备密钥包裹 dataKey | 否 | 用户开启记住设备 |
| 命令面板 | 浏览器内存 | 不索引隐私内容 | 否 | 侧栏/AI/memo 就绪 |
| PWA 缓存 | Cache Storage | 只缓存 app shell | 否 | HTTPS、service worker |
| Passkey/设备管理 | IndexedDB + 可选服务端 | WebAuthn 签名 | 否 | 扩展阶段 H |

## 4. 加密与密钥体系

### 4.1 现状

- 工作区使用 v3 envelope：PBKDF2-SHA256 600k + AES-256-GCM；随机 `dataKey`，密码 KEK 包裹，恢复码再包裹一份。
- 解锁后的 `dataKey` 目前放在 `sessionStorage`，只覆盖当前标签页；新标签页/新设备需要重新输入密码。
- 服务端只校验 envelope 外壳和大小，无法校验内部链接/分组。

### 4.2 设备自动解锁（Device Vault）

目标：设备首次解锁后，正常同步（上传/下载）不再弹密码；多台设备各自完成一次“填写密钥”即可。

**存储设计**

- 新增 `device-vault.js`，使用 IndexedDB（不是 localStorage）：
  - 每个浏览器生成一个 **不可导出** 的 AES-GCM `deviceKey`（`extractable: false`），存进 IndexedDB；
  - 用 `deviceKey` 加密主 `dataKey`，保存 `{userId, envelopeId, iv, wrappedDataKey, createdAt}`；
  - `envelopeId` 取 envelope 的 `salt`/`wrappedKey` 指纹，用于检测密钥被重建；
  - 解锁时用 `deviceKey` 解出 `dataKey`，再验证 envelope 的 `check`；失败就删除 vault 并回退密码解锁。
- 不保存密码，不保存明文 dataKey，不把 dataKey 放进 URL、日志或 `localStorage`。

**交互**

- 首次解锁（新设备/新浏览器）时在解锁弹窗增加：
  - “在此设备上记住解锁”复选框，默认勾选，并显示一句风险说明；
  - 取消勾选则只保留当前标签页的 `sessionStorage` 缓存。
- 已记住设备时：
  - 页面加载、刷新、新标签页、上传/下载都直接使用 vault；
  - 账号会话有效即可同步，不再要求加密密码；
  - 账号菜单显示“本机已记住解锁”，提供“忘记此设备”按钮，点击立即清除 IndexedDB 中的包裹密钥和内存密钥。
- 退出登录：
  - 默认清除内存密钥与设备 vault，避免共用电脑被下一位使用者直接打开；
  - 如果用户明确选择“保留本机数据”，只保留本地加密缓存，不保留可自动解密的 vault。
- 锁定/超时（可选，下一轮后段）：
  - 手动“锁定本机”清除内存密钥但保留 vault；
  - 可配置空闲 N 分钟后锁定，重新输入密码或使用系统生物识别（后续扩展）。

**多设备语义**

- 每台设备都需要首次输入一次加密密码；这是“设备信任”，不是把密码复制到服务端。
- 设备之间不共享设备密钥；服务端不保存 deviceKey，也不保存“已解锁”状态。
- 修改加密密码只 rewrap dataKey，`dataKey` 不变，因此已信任设备的 vault 仍然有效；这是预期行为。
- 未来若支持“重置数据密钥”，所有 vault 自动失效。

**安全边界**

- vault 让“拿到已登录浏览器配置的人”可以直接解密，保护等级低于每次输入密码；
- 它防的是服务端/备份泄露和普通旁观，不防设备被入侵、恶意扩展、键盘记录器；
- 建议在 UI 中明确提示，并允许每台设备单独忘记。

### 4.3 Secret envelope v4

现有 v3 的 AAD 是固定的工作区语义。AI 配置、备忘录和隐私空间需要防止 **密文互换**（把 memo 密文塞进 AI 配置）和 **用途混淆**，因此新增 v4：

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

- `kind=ai/memo`：
  - 使用主 `dataKey` 经 HKDF-SHA256 派生用途子密钥；
  - `info = "qingdh:v4:<kind>:key"`；
  - AAD = `"qingdh:v4:<kind>:data"`；
  - 不需要再次 PBKDF2，因此自动解锁后可以无感同步。
- `kind=privacy`：
  - 使用独立密码派生 KEK，独立随机 `dataKey`；
  - envelope 增加 `salt`、`wrappedKey`、`check`、`recovery.wrappedKey`；
  - AAD 使用 `"qingdh:v4:privacy:data"`；
  - 不与主 dataKey 混用，忘记隐私密码不影响普通数据。
- 服务端 `docval` 增加 v4 校验：
  - 只接受 allowlist 的 `kind`；
  - 校验 Base64 长度、总大小、必填字段；
  - 不解析内部 JSON，不校验 AI 供应商、备忘录字段。
- 兼容性：
  - v2 / v3 继续可读；
  - 主工作区不会升级到 v4，避免破坏已有 envelope；
  - secret 和主工作区是两套独立 revision。

### 4.4 隐私空间的密钥

- 独立的隐私密码（不是登录密码，也不是主加密密码）。
- 创建时生成独立 `privacyDataKey`，密码 KEK 包裹，恢复码再包裹；必须展示一次恢复码。
- **不写入 Device Vault**：每次进入隐私空间都要验证密码；关闭/超时立即清除内存密钥。
- 管理员和普通同步接口都只能拿到 v4 密文；普通工作区不包含隐私数据。
- 忘记隐私密码且丢失恢复码 = 隐私空间不可恢复；主数据不受影响。

### 4.5 威胁模型更新

需要明确写在 UI/文档里的新事实：

- AI 密钥在服务端是密文；但使用 **服务端代理** 调用上游时，浏览器必须把解密后的密钥随请求发给服务端，服务端在内存中短暂可见。服务端不得记录请求体/密钥，并应限制日志。
- 若供应商支持 CORS，可优先走 **浏览器直连**，密钥不经过氢导航服务端；但密钥会出现在浏览器网络面板，且仍受浏览器扩展/恶意脚本威胁。
- 设备 vault 提高了便利性，但降低了本机丢失时的安全性；这是用户显式选择的权衡。
- 隐私空间防的是服务端/管理员/备份和普通窥屏，不防恶意浏览器扩展、系统级木马、屏幕录制。

## 5. AI 搜索

### 5.1 供应商分类

抽象成 provider registry，而不是把某一家写死在搜索框：

| 类型 | 示例 | 是否需要密钥 | 打开方式 |
| --- | --- | --- | --- |
| URL 跳转 | 秘塔 AI 网页版、其他 AI 搜索网页 | 否 | 新标签页/当前页 |
| API 直连 | 支持浏览器 CORS 的 API | 是 | 页面内结果面板 |
| API 代理 | DeepSeek 搜索 API 等 | 是 | 服务端代理 + 流式返回 |

具体 endpoint、model、请求字段在实现时按供应商文档确认；适配器层隔离差异，避免把某家 API 写进 UI。

### 5.2 AI 配置数据

`kind='ai'` 的明文 JSON 建议：

```json
{
  "version": 1,
  "defaultProvider": "metaso",
  "providers": [
    {
      "id": "metaso",
      "label": "秘塔 AI",
      "mode": "web",
      "enabled": true,
      "urlTemplate": "https://metaso.cn/?q={query}"
    },
    {
      "id": "deepseek",
      "label": "DeepSeek",
      "mode": "api",
      "enabled": true,
      "model": "deepseek-chat",
      "apiKey": "sk-...",
      "baseUrl": ""
    }
  ]
}
```

- 整个 JSON 用 `secret(kind='ai')` 加密后上传；服务端只看到 v4 blob。
- `apiKey` 永远不回显完整值：UI 只显示“已配置”，编辑时留空表示保持原值；管理员接口不返回。
- 配置变更走独立的 secret revision，不与工作区分组混在一起。
- **已确认：AI 云端配置强制依赖主加密**。未开启时只能使用 URL 跳转型 provider，或先引导开启主加密；不把 API key 以明文同步。

### 5.3 请求路径

**路径 A：URL 跳转（Metaso 等）**

- 不经过服务端，不保存查询（除非用户开启本地 AI 历史）。
- 在搜索框选择 AI provider 后按 Enter，直接打开对应 URL。
- 优点：零密钥、零服务端可见；缺点：没有统一的流式答案 UI。

**路径 B：浏览器直连 API**

- 客户端解密 provider config，直接 `fetch` 上游；
- 适合支持 CORS 的供应商；
- 密钥不经过氢导航服务端，但会出现在浏览器网络里；
- 需要处理 CORS 失败并提示切换到代理模式。

**路径 C：服务端代理（默认给 DeepSeek 这类不支持 CORS 的 API）**

- 客户端从 `ai` secret 中解出密钥，调用：
  - `POST /api/v1/ai/chat`，body 包含 `provider`、`model`、`query`/`messages`、`stream` 和 **本次请求的临时 apiKey**；
- 服务端按 provider allowlist 选择固定上游地址，不根据用户输入拼接任意 URL；
- 服务端不持久化密钥，不记录请求体/响应体/Authorization；
- 以 SSE 或 chunked 方式流式返回；
- 客户端可中止请求（AbortController），服务端跟随 context 取消。

### 5.4 代理安全

- **SSRF**：MVP 只允许服务端配置的 provider 固定 host，不接受任意 `baseUrl`；后续如开放自定义，需要域名 allowlist、禁止内网 IP/元数据地址、重定向限制。
- **密钥**：只在内存中使用；日志、错误信息、metrics 不包含 key；错误返回统一脱敏。
- **CSRF**：沿用 JSON + Origin/Referer 校验；要求登录会话。
- **提示注入**：搜索结果/网页内容是不可信输入，不能执行其中指令；答案必须带来源；不做自动工具调用。
- **限额**：查询长度、历史轮数、max tokens、单用户每分钟/每日调用次数、上游超时、响应体上限；超限返回明确错误。
- **成本**：UI 显示“由你的 API Key 计费”；可增加每日 token 预算提醒，但不做支付。
- **密钥测试**：提供“测试连接”，只发最小请求；失败不泄露 key。

### 5.5 UI

- 搜索框保留普通搜索引擎；增加 AI 模式入口（下拉选择 provider 或独立按钮）。
- 选择 AI 后按 Enter 不跳转，而是在搜索框下方展开 **答案面板**：
  - 流式文字、停止按钮、重新生成；
  - 来源卡片（标题/域名/链接）；
  - “复制答案”“保存到备忘录”；
  - 错误态：未配置密钥、额度不足、网络失败、上游超时；
  - 查询会发送给对应供应商的提示。
- 面板是临时 UI，不写进普通工作区；AI 历史如要做，单独存本地加密或 secret，不默认上传。
- 移动端答案面板全屏，Esc 关闭。

## 6. 备忘录

### 6.1 定位

不是“第二个书签列表”，而是快速、私密的短文本/清单入口；默认不与普通链接混排。

### 6.2 数据模型

`kind='memo'` 的明文 JSON：

```json
{
  "version": 1,
  "memos": [
    {
      "id": "uuid",
      "title": "周会",
      "body": "……",
      "tags": ["工作"],
      "pinned": false,
      "archived": false,
      "createdAt": 0,
      "updatedAt": 0,
      "deletedAt": null
    }
  ]
}
```

- 软删除保留墓碑，30 天后客户端清理；
- 按 `id` + `updatedAt` 合并；同 id 冲突保留较新版本，必要时提示；
- 限额：MVP ≤ 300 条、单条正文 ≤ 20,000 字符、整个 secret ≤ 256 KiB（加密后仍低于 512 KiB）；知识库扩展见 11.2。

### 6.3 加密与同步

- 使用主 dataKey 派生 `kind='memo'` 子密钥，AAD 带 `memo`；
- 服务端只存 v4 密文；管理后台不提供 memo 读取接口；
- 与工作区独立 revision，memo 修改不推高导航文档 revision；
- 设备自动解锁后，memo 上传/下载无额外密码；
- 本地缓存使用 IndexedDB 保存密文 + vault，不把 memo 明文写入 `localStorage`；
- **已确认：云端备忘录强制依赖主加密**。未开启主加密时不提供云端 memo；纯本地 memo 作为后续扩展，且不能写入服务端。

### 6.4 UI

- 侧栏“备忘录”入口；
- 列表 + 编辑器两栏（移动端单栏切换）；
- 快捷捕获：`Ctrl+Shift+M` 打开浮层，输入即存，Esc 关闭；
- 支持置顶、归档、标签筛选、客户端全文搜索；
- 自动保存（500ms 防抖）+ 同步状态；
- 可选 Markdown 预览，MVP 先纯文本 + 换行，避免引入解析库。

## 7. 隐私空间

### 7.1 定位与内容

隐私空间是一个 **独立加密的私有工作区**。已确认 MVP 范围：

- 私密分组和链接（复用现有 group/link 数据结构）；
- 私密备忘录（复用 memo 数据结构，但放在 privacy 文档内）；
- 不包含普通工作区数据，不进入普通搜索/侧栏/管理后台。

后续可扩展私密 AI 密钥、文件等；MVP 不做附件。

### 7.2 进入方式

- 快捷键可配置，默认 `Alt+Shift+P`（实现时检测浏览器/系统冲突，允许改键）；
- 快捷键只在非输入框、非弹窗输入状态触发；如果冲突，设置页提示；
- 按快捷键打开 **锁屏弹窗**，输入隐私密码后才渲染内容；
- 不在普通侧栏放明显入口；可在设置里看到“隐私空间”配置和改快捷键；
- 支持命令面板后续扩展作为第二入口。

### 7.3 加密与同步

- 独立密码 + 独立 `privacyDataKey`，v4 `keySource='password'`；
- 创建时生成恢复码，必须让用户保存；
- 服务端只存密文，`kind='privacy'`；管理后台无读取接口；
- 每次进入都验证密码，不使用设备 vault；关闭/超时清除内存密钥；
- 多设备同步同一份隐私密文；每台设备首次进入都要密码；
- 隐私空间创建不要求主数据已加密，但要求登录账号。

### 7.4 生命周期

- 打开：快捷键 → 密码 → 拉取/解密 → 全屏隐私工作区；
- 自动锁定：空闲 3 分钟、标签页隐藏超过 30 秒、手动点“锁定”；
- 锁定时清空 DOM 中的隐私内容、内存密钥、剪贴板中的隐私复制内容；
- 关闭浏览器/退出登录立即锁定；
- 页面标题保持“氢导航”，不出现隐私空间字样；
- 忘记密码：恢复码可重置隐私密码；两者都丢失则隐私数据不可恢复。

### 7.5 安全边界

- 防管理员/备份/普通同步窥探；
- 不防恶意扩展、系统级键盘记录、屏幕录制、浏览器历史/缓存取证；
- 不在普通页面渲染隐私内容，避免误截图；
- 快捷键本身不是安全边界，只是入口。

## 8. 侧栏与可隐藏布局

### 8.1 结构

已确认放左侧。把底部功能区拆成左侧栏，桌面端两态：

- **收起**：约 60–68px 图标栏；
- **展开**：约 220–240px，显示文字标签；
- 顶部：首页/搜索、备忘录、AI；
- 中部：主题、编辑、设置；
- 底部：同步状态、账号、锁屏/隐藏；
- 隐私空间不放入普通侧栏，只保留快捷键入口。

### 8.2 隐藏

- 侧栏支持完全隐藏（宽度 0），边缘保留一个极窄的唤出热区/按钮；
- 快捷键切换显示，建议 `Alt+S` 或 `Ctrl+Shift+.`（实现时确认不与浏览器冲突）；
- 状态写入 `prefs.sidebar`：`expanded | collapsed | hidden`；
- 刷新后保持；
- 鼠标移出自动收起可作为可选设置，默认手动，避免误触。

### 8.3 响应式与可访问性

- 桌面：侧栏占位，主内容居中偏移；展开时不遮挡搜索框；
- 移动端：侧栏变抽屉，从左侧滑出，带遮罩和焦点陷阱；
- 键盘：Tab 顺序、Esc 关闭、焦点返回触发按钮；
- 减少动画偏好下关闭滑入动画；
- 底部 footer 移除后，同步状态和账号入口仍在侧栏底部可见。

## 9. 时钟视觉

### 9.1 方向

已确认默认采用编辑式排版。保留“大时间”作为首页视觉锚点，但从“默认大字”改成有层次的编辑式排版：

- 时间：等宽数字（`font-variant-numeric: tabular-nums`），字号 `clamp(64px, 11vw, 132px)`，字重 500，字距收紧；
- 日期/星期：小号、字距略宽，放在时间下方或右侧；
- 问候语：与昵称组合，弱化颜色，不和时间抢层级；
- 季节强调：用当季色做一条细线/柔和光晕/小圆点，不使用大面积渐变；
- 明暗主题分别调整对比度和光晕；
- 默认不显示秒，避免每秒跳动；可在设置中开“显示秒”；
- 时间变化用轻微淡入/位移，`prefers-reduced-motion` 下禁用。

### 9.2 结构建议

```text
18:47
2026 年 10 月 28 日 · 星期三
晚上好，XiaoXuRa
```

- 桌面居中；移动端缩小并允许日期换行；
- 时间使用 `Intl.DateTimeFormat` 本地化，24/12 小时制作为偏好；
- 不再用 `setInterval(1000)` 驱动无秒时钟，改为分钟边界对齐，降低唤醒。

### 9.3 可选设置

- 时钟样式：`编辑式（默认） / 极简`；
- 显示秒：开/关；
- 24 小时制：跟随系统/强制 24h/12h；
- 这些设置继续走设备偏好，不进入同步 payload。

## 10. 数据与 API 变更

### 10.1 数据库

新增迁移 `0004_user_secrets.sql`：

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

- 只存 v4 密文；不存 AI 明文、memo 明文、隐私明文；
- 管理后台不查询该表内容；
- 备份包含密文即可。

扩展阶段 H 若做服务端设备管理，再增加 `0005_webauthn_devices.sql`（可选）：

```sql
CREATE TABLE webauthn_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id bytea NOT NULL UNIQUE,
    public_key bytea NOT NULL,
    sign_count bigint NOT NULL DEFAULT 0,
    transports text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);

CREATE TABLE trusted_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id text NOT NULL,
    label text NOT NULL DEFAULT '',
    credential_id bytea,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    UNIQUE (user_id, device_id)
);
```

这两张表只在扩展阶段 H 使用；不做服务端设备管理时，Passkey 仅作为本地 Device Vault 的解锁门，不新增表。

### 10.2 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/secrets/{kind}` | 返回 `{revision,payload,updatedAt}`；kind 白名单 |
| PUT | `/api/v1/secrets/{kind}` | `{baseRevision,payload}`；409 返回 current |
| POST | `/api/v1/ai/chat` | 代理调用；key 仅本次请求；SSE/chunked |
| POST | `/api/v1/ai/test` | 可选，测试供应商连接 |
| POST | `/api/v1/webauthn/register/begin` | 扩展 H，可选：注册 Passkey challenge |
| POST | `/api/v1/webauthn/register/finish` | 扩展 H，可选：校验并保存凭据 |
| POST | `/api/v1/webauthn/assert/begin` | 扩展 H，可选：设备解锁 challenge |
| POST | `/api/v1/webauthn/assert/finish` | 扩展 H，可选：校验签名 |
| GET | `/api/v1/devices` | 扩展 H，可选：可信设备列表 |
| DELETE | `/api/v1/devices/{id}` | 扩展 H，可选：远程撤销设备 |

- 全部要求登录会话；沿用 Origin/Referer + JSON 校验；
- secret 的 kind 不能由 URL 任意扩展；
- AI 代理不落库，不写请求体日志；
- 管理后台不新增 secret 查看接口。

### 10.3 docval

- 支持 v4 `ai/memo/privacy`；
- 校验 `kind`、`keySource`、Base64 长度、总大小；
- 拒绝 `kind` 与字段组合不匹配的 envelope；
- 继续支持 v2/v3。

### 10.4 限额

| 项目 | 限制 |
| --- | --- |
| secret envelope | ≤ 512 KiB |
| memo 条数/正文 | MVP ≤ 300 条 / 20k 字符；知识库扩展 ≤ 500 条 / 50k 字符（需实测 envelope） |
| AI 配置 | ≤ 32 KiB |
| AI 查询 | ≤ 2,000 字符；历史 ≤ 10 轮 |
| AI 超时 | 60s；可中止 |
| AI 频率 | 先做每用户 10 次/分钟、每日上限可配置 |

## 11. 扩展路线（已确认）

以下 5 项已确认纳入路线图。它们排在核心阶段 A–E 之后，各自独立开关、独立发布，不阻塞首期。

### 11.1 全局命令面板（Ctrl+K）

**目标**：侧栏可以隐藏，但功能不能失去入口；把“点击侧栏”升级为“键盘直达”。

- 当前 `Ctrl+K` 只聚焦搜索框，改为打开命令面板；`/` 仍然聚焦搜索。
- 空输入时显示动作：
  - 搜索网页（默认搜索引擎）；
  - 问 AI（选择 provider，或直接用默认）；
  - 新建备忘录；
  - 打开备忘录；
  - 打开隐私空间；
  - 设置、切换主题、编辑模式、导出、账号。
- 有输入时：
  - 第一项始终是“用默认搜索引擎搜索 …”；
  - 其余为模糊匹配的链接、分组、备忘录标题、静态动作；
  - 支持 ↑↓、Enter、Esc、Tab，焦点陷阱和 `aria-activedescendant`。
- 隐私约束：
  - 隐私空间内容不进入索引，只保留“打开隐私空间”动作；
  - 备忘录只有在主数据已自动解锁时才可搜索；
  - AI 密钥、API Key 不出现在命令面板结果中。
- 移动端用顶部命令 sheet，不依赖物理键盘。
- 纯客户端功能，不新增数据库或接口。

验收：`Ctrl+K` 在首页、备忘录、隐私锁屏外都能打开；不会误触隐私内容；键盘可完成全部操作。

### 11.2 备忘录知识库

**目标**：从“便签”升级为可长期使用的轻量知识库。

- 安全 Markdown 子集：标题、粗体、斜体、列表、任务清单、代码、链接；先转义再渲染，禁止原始 HTML。
- 任务清单：`- [ ]` / `- [x]`，可在预览里直接勾选并回写。
- 标签筛选、置顶、归档、全文搜索。
- 提醒：memo 增加 `remindAt`，客户端用 Notification API 提醒；应用关闭时不能保证触发，不承诺服务端推送。
- 双向链接：扫描正文中的 `[[标题]]`，生成反向链接索引；索引只在客户端。
- 本地全文搜索：IndexedDB 建倒排/前缀索引，搜索前必须已解锁；不上传搜索词。
- 导出：Markdown、JSON；导出前提示本地文件为明文。
- 数据模型增量：
  - `format: "markdown"`；
  - `remindAt: number | null`；
  - `checklist: boolean`（可省略，任务项直接从正文解析）。
- 限额从 MVP 的 300 条 / 20k 字符提升到 500 条 / 50k 字符，但必须先实测 v4 envelope 不超过 512 KiB。
- 阶段 G 在阶段 C 的 memo 基础上增量实现，不改已有 memo 的 id/同步语义。

验收：Markdown 不产生 XSS；任务勾选可保存；提醒在页面打开时触发；500 条 memo 时同步和搜索仍可接受。

### 11.3 Passkey / 设备信任增强

**目标**：让 Device Vault 从“浏览器本地密钥”升级为“系统生物识别 + 可管理设备”，并支持撤销。

分两步，避免一次引入过多服务端复杂度：

**H1：本地 Passkey 门禁**

- 用 WebAuthn 平台认证器（Touch ID / Windows Hello / Android 生物识别）作为 Device Vault 的解锁门。
- 凭据公钥、credential id 保存在 IndexedDB；断言签名在本地校验。
- 成功断言后解出设备包裹的 dataKey；失败可回退加密密码。
- 不新增服务端表，不改变现有同步协议。

**H2：服务端设备管理（可选）**

- 增加 `webauthn_credentials`、`trusted_devices`（见 10.1）。
- challenge/verify 接口；RP ID 使用 `baseUrl` 的 host；必须 HTTPS。
- 设备列表显示名称、最近活跃、撤销按钮。
- 远程撤销：标记 `revoked_at`，撤销会话；客户端登录/同步时发现撤销，清除本机 vault 和内存密钥。
- 服务端无法远程擦除已离线的本机缓存，只能阻止继续同步；UI 必须说明。
- 设备密钥轮换：重新生成设备密钥并 rewrap dataKey；只有在怀疑 dataKey 泄露时才做全量数据重加密，作为更后续能力。

验收：注册/断言/回退密码/撤销流程可用；撤销设备后旧设备不能继续同步；Passkey 不可用时不影响密码解锁。

### 11.4 PWA + 书签导入

**目标**：可安装、离线打开，并能从浏览器书签平滑迁移。

- 增加 `manifest.webmanifest`、图标、`service-worker.js`。
- 缓存边界：
  - 只缓存 app shell（HTML/CSS/JS/字体/图标）；
  - **不缓存** `/api/v1/*`，尤其不缓存 secrets、AI 请求、隐私响应；
  - 不把解密后的普通数据或 memo 明文写入 Cache Storage。
- 离线策略：
  - 游客/本地模式可离线打开；
  - 已登录用户可读本地加密缓存，联网后同步；
  - 页面更新使用版本化 cache + “有新版本，点击刷新”提示。
- 安全：
  - HTTPS；CSP 增加 `worker-src 'self'`；
  - service worker 只接管同源静态资源；
  - 退出登录/清除数据时可清理 cache。
- 书签导入：
  - 解析 Netscape Bookmark HTML（Chrome/Edge/Firefox 导出格式），纯客户端；
  - 文件夹映射为分组，重复 URL 去重，导入前预览数量和冲突；
  - 默认导入普通工作区，不导入隐私空间；
  - 导入后按现有 normalize/limit 规则处理。
- 不新增服务端接口；只增加静态资源。

验收：断网可打开起始页；API 响应不被缓存；导入 Chrome 书签后分组/链接正确；更新提示可回退。

### 11.5 时钟专注面板（已移除）

> 2026-10-29 按用户要求移除：不再提供 Pomodoro、世界时钟和专注模式。

**目标**：让时钟区域成为可选的“专注仪表”，而不是堆满首页的挂件。

- 默认关闭，仅在时钟区域保留一个不抢视线的“专注”入口。
- 模块：
  - Pomodoro：25/5 默认，可改 15/30/50；开始/暂停/重置；结束通知；
  - 世界时钟：最多 3 个城市；
  - 日历/天气：后续可选；天气需要额外 API/key，默认不启用，且必须说明数据去向。
- 专注模式：隐藏链接区和侧栏，只保留时钟、计时器和退出按钮；Esc 退出。
- 状态存 `prefs.focus` 与本地 IndexedDB/localStorage 计时状态；不上传服务端。
- 页面关闭后计时不保证继续；不承诺后台通知。
- 视觉上沿用阶段 A 的编辑式时钟，不另起一套风格。

验收：计时准确、刷新可恢复；专注模式可退出；默认不增加首页视觉负担；通知权限被拒绝时安静降级。

## 12. 分期

### 阶段 A：视觉与布局（低风险，可先发）

- 侧栏结构、隐藏状态、移动端抽屉；
- 时钟排版、主题/季节适配、响应式；
- 移除底部 footer，迁移账号/同步/主题/设置入口。

验收：不改变同步和加密逻辑；桌面/移动端无布局跳动；隐藏状态刷新保持。

### 阶段 B：设备信任 + secret 基础设施

- `device-vault.js`、IndexedDB、记住/忘记设备；
- v4 secret envelope、`user_secrets` 表、GET/PUT API、docval；
- 加密模块增加 HKDF 子密钥与用途 AAD；
- 账号菜单增加“本机已记住/忘记此设备”。

验收：同一设备首次解锁后刷新/新标签页同步无提示；另一台设备首次仍需密码；忘记设备后恢复提示。

### 阶段 C：备忘录

- memo UI、快速捕获、标签/搜索/归档；
- memo secret 同步、冲突合并、离线缓存；
- 管理后台确认不可见。

验收：多设备 CRUD 同步；刷新/重启后自动解锁；管理员接口无法取得明文。

### 阶段 D：AI 搜索

- provider registry、配置 UI、密钥加密存储；
- URL 跳转型 provider；
- 代理型 provider、流式答案面板、来源、停止/重试；
- 限额、错误处理、密钥脱敏。

验收：Metaso 类 URL provider 可直接打开；DeepSeek 类 API 能流式回答；抓包/日志无明文 key；管理员看不到 key。

### 阶段 E：隐私空间

- 独立密码/恢复码/密钥；
- 快捷键锁屏、隐私工作区（私密分组/链接 + 私密 memo）；
- 自动锁定、清空内存/DOM；
- 管理后台无入口。

验收：快捷键进入必须密码；普通工作区/侧栏/管理后台看不到隐私内容；锁定后 DOM 无残留。

### 阶段 F：全局命令面板

- `Ctrl+K` 命令面板，替代“只聚焦搜索”；
- 搜索、AI、memo、隐私入口、设置、主题统一检索；
- 隐私内容不索引，memo 仅解锁后可检索；
- 键盘导航、移动端 sheet。

验收：命令面板可用键盘完成搜索/打开 memo/打开隐私空间；不会泄露隐私索引。

### 阶段 G：备忘录知识库

- Markdown 安全渲染、任务清单、标签、提醒、双向链接；
- IndexedDB 本地全文索引；
- Markdown/JSON 导出，容量提升到 500 条 / 50k 字符并实测 envelope。

验收：XSS 测试通过；任务勾选/提醒/搜索可用；大数据量同步不超限。

### 阶段 H：Passkey / 设备信任增强

- H1：WebAuthn 本地解锁 Device Vault，密码回退；
- H2（可选）：服务端可信设备注册、列表、远程撤销；
- 设备密钥轮换；撤销后旧设备停止同步；
- 明确“服务端无法擦除离线本机缓存”。

验收：注册/断言/回退/撤销全流程可用；撤销后旧设备同步被拒绝。

### 阶段 I：PWA + 书签导入

- manifest、图标、service worker、离线 app shell；
- 不缓存 API/secrets/AI/隐私响应；
- 版本化更新提示；
- Netscape Bookmark HTML 解析、预览、去重、导入普通工作区。

验收：断网可打开；Cache Storage 无 API 响应；书签导入分组正确。

### 阶段 J：时钟专注面板（已移除）

> 2026-10-29 按用户要求移除，相关文件、快捷键与本地存储键已清理。

- Pomodoro、世界时钟；日历/天气保持可选且默认关闭；
- 专注模式隐藏链接和侧栏；
- 计时状态本地持久化，通知权限安静降级。

验收：计时/刷新恢复/退出专注正常；默认首页不增加视觉负担。

## 13. 测试计划

### 加密

- HKDF 子密钥隔离：memo 密文不能当 ai 密文解开；
- v4 AAD/kind 交换必须失败；
- 设备 vault 正常解锁、损坏/换 dataKey 失效、忘记设备清除；
- 隐私独立密码与恢复码；
- Node 测试 + 浏览器 WebCrypto 测试。

### 服务端

- secret 认证、kind 白名单、revision 冲突、大小限制；
- 管理员接口不返回 secret；
- AI 代理 provider allowlist、超时、取消、限流、日志脱敏；
- 旧 v2/v3 兼容。

### 前端

- 新标签页/刷新/第二设备自动解锁；
- memo 离线编辑、冲突合并；
- AI 流式、停止、错误态；
- 隐私快捷键、自动锁定、DOM 清理；
- 侧栏隐藏/移动端抽屉；
- 时钟 12/24h、主题/季节、reduced motion；
- 命令面板键盘操作、隐私内容不进入索引；
- memo Markdown XSS、任务勾选、提醒、全文搜索；
- Passkey 注册/断言/密码回退/远程撤销；
- PWA 离线、Cache Storage 不含 API、更新提示；
- 专注计时恢复与退出。

### 安全清单

- 密钥不出现在 URL、localStorage、日志、错误信息；
- secret 不出现在普通工作区响应；
- 隐私内容不进入普通搜索/导出；
- AI 代理不接受任意 URL；
- 设备 vault 清除路径可验证；
- service worker 不缓存 API/隐私/AI 响应；
- 命令面板/本地索引在锁定时清空。

## 14. 开放问题

已确认事项见 1.1；以下是仍需在实现前确认的点：

1. **AI 供应商 API**：秘塔/DeepSeek 的具体接口、模型、CORS 和计费方式需要按官方文档确认，适配器接口先定。
2. **Passkey 服务端范围**：先做 H1（本地门禁）还是一步到 H2（可信设备注册/远程撤销）；建议先 H1。
3. **PWA 离线范围**：是否缓存 memo 密文供离线阅读/编辑；建议缓存密文，但绝不缓存明文和 API 响应。
4. **专注面板模块**：首版只做 Pomodoro + 世界时钟，日历/天气后置；天气需要 key 和额外隐私说明。
5. **隐私空间恢复码**：建议必须生成；如果用户坚持不要，需要明确“忘记即丢”。
6. **AI 历史**：默认不保存；如保存，需明确本地加密还是云端 secret。

## 15. 非目标

- 不做多人协作/共享空间；
- 不做服务端全文搜索；
- 不做文件/图片附件；
- 不做服务端保存 AI 明文密钥；
- 不做“管理员代解密”；
- 不做服务端 memo 全文搜索；
- 不做 Web Push/后台常驻提醒（提醒只在页面打开时保证）；
- 不做账号登录 Passkey（本轮 Passkey 只用于设备解锁，登录仍是密码）；
- 不做默认天气/日历挂件；
- 不在本轮引入前端框架或构建链。

## 16. 实施状态（2026-10-28）

| 阶段 | 状态 | 主要落地内容 |
| --- | --- | --- |
| A 侧栏与时钟 | 已实现 | 左置侧栏（展开/图标栏/隐藏/移动端抽屉）、编辑式时钟、分钟对齐、12/24h、显示秒、季节细线、设置持久化 |
| B 设备信任 + secret | 已实现 | `device-vault.js`、v4 secret envelope、HKDF 子密钥、`user_secrets`、GET/PUT API、docval v4、账号内记住/忘记设备 |
| C 备忘录 | 已实现 | 列表/编辑器、快速捕获、标签/搜索/置顶/归档、500ms 自动保存、revision 冲突自动合并、侧栏入口与计数 |
| D AI 搜索 | 已实现 | provider registry、加密配置、密钥不回显、URL 跳转、服务端流式代理（DeepSeek）、浏览器直连、答案面板、停止/重试/复制/存备忘录、限额与脱敏 |
| E 隐私空间 | 已实现 | 独立密码/密钥/恢复码、保留密码重置、回退码重置、私密分组/链接、私密备忘录、快捷键、3 分钟空闲/30 秒隐藏锁定、DOM/内存/剪贴板清理 |
| F 命令面板 | 已实现 | `Ctrl/⌘+K`、搜索/AI/memo/隐私/设置/主题/导出/账号、键盘导航、隐私不索引、memo 仅解锁后索引 |
| G 备忘录知识库 | 已实现 | 安全 Markdown、任务清单回写、标签、提醒（页面内 + Notification）、`[[双链]]` 反向链接、Markdown/JSON 导出、500 条/5 万字与总量预算 |
| H Passkey | H1 已实现 | 平台认证器注册/断言、本地校验签名、Device Vault 门禁、5 分钟内存 gate、密码回退；**H2 未实现** |
| I PWA + 书签导入 | 已实现 | manifest/图标/service worker、app shell 离线、版本提示、不缓存 API/admin、Netscape 书签解析/预览/去重/导入 |
| J 专注面板 | 已移除 | 2026-10-29 按用户要求删除；不再提供 Pomodoro、世界时钟和专注模式 |

### 16.1 与规划的差异

1. **AI 供应商**：代理 allowlist 目前只有 DeepSeek（`deepseek-chat` / `deepseek-reasoner`），秘塔等走 URL 跳转；浏览器直连使用 OpenAI 兼容协议。具体厂商接口仍集中在适配器层，后续可增量添加。
2. **本地全文索引**：为保证“memo 明文不落盘”，全文搜索仍在内存中对已解锁的 memo 进行，没有把词项写入 IndexedDB 倒排索引；500 条规模下搜索与同步可接受。
3. **Passkey**：按建议先做 H1（本地门禁），H2 的服务端可信设备、远程撤销与表结构未实现。
4. **PWA 离线**：只缓存 app shell；已登录用户的普通数据仍走既有本地缓存，memo 密文不写入 Cache Storage。
5. **AI 历史**：默认不持久化，只保留当前页面的会话上下文。
6. **天气/日历**：专注面板只做 Pomodoro 与世界时钟，未引入额外 API/Key。

### 16.2 明确未做（后续轮次）

- Passkey H2 / 服务端设备管理 / 远程撤销；
- IndexedDB 本地全文倒排索引；
- 真实第三方 AI API 的 CORS 兼容性矩阵与计费展示；
- 文件/图片附件、多人协作、服务端搜索、Web Push；
- “关闭加密回到明文”和“重新生成恢复码”。
