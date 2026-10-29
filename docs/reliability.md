# 数据可靠性与安全边界加固（2026-10-29）

本轮不新增功能，集中修复“保存可靠性、账号隔离、加密状态管理”和几处服务端边界问题。对应前端行为回归见 [`web-tests/`](../web-tests/README.md)。

## 1. 保存期间继续编辑

**问题**：工作区上传成功后无条件清除 `dirty`；隐私空间保存成功也直接清零。请求期间的新编辑会被标记为已保存但没有真正上传，隐私空间还会在锁定后丢数据。

**修复**：

- 工作区新增 `sync.editSeq`：每次本地修改递增；上传前记录代次，成功后只有代次一致才清除 `dirty`，否则保持待同步并立刻安排下一次推送。
- 隐私空间新增 `editSeq/savedSeq`：保存前记录代次，成功后比较并决定是否继续提交；连续保存在 `savePromise` 上串行化。
- 手动锁定隐私空间时会等待在途保存，并循环提交期间新增的编辑（最多 5 轮，失败则停止等待）；空闲/隐藏锁定仍优先立即清除，迟到结果由生命周期代次丢弃。

**回归**：`web-tests/reliability.mjs` 用 CDP 延迟 PUT，在延迟期间新增链接，断言至少两次 PUT 且服务端最终包含两条新链接。

## 2. 账号切换与 AI 缓存

**问题**：AI 配置缓存没有账号归属，退出登录不清理；同页切号后可能继续使用上一个账号的 API Key、历史与答案。

**修复**：

- `QingdhAI.reset()` 清空 config、active provider、历史、答案、来源，关闭面板，并中止在途请求；`resetCryptoState()` 统一调用。
- AI 加载配置带 `epoch`，切号后迟到的配置不会写回。
- `QingdhSecrets` 增加按 kind 的代次；退出/换账号全部失效，锁定单个功能只让该 kind 的在途请求作废，避免误伤其他 kind。

**回归**：脚本登录 A、加载 AI 配置，退出后断言 `QingdhSecrets.getCached('ai')` 为空、AI 面板关闭、active provider 为空。

## 3. 加密同步冲突

**问题**：`reconcile()` 先解密云端文档，冲突时又把解密后的文档传给 `resolveConflict()` 再解码一次；第二次解码进入“未加密”分支，关闭 `cryptoState`，随后尝试明文上传。

**修复**：

- 冲突路径只传递原始 envelope，由 `resolveConflict()` 解码一次；`reconcile()` 只在真正需要采用云端数据时才解码。
- `decodePayload()` 增加防御：已处于“加密且已解锁”时收到已解密文档，视为重复解码，不再关闭加密状态。
- 所有冲突合流在账号/会话代次变化后停止回写。

**回归**：双标签页同账号制造 revision 冲突，选择合并后断言加密状态仍为“已开启”、服务端 payload 仍是 `version: 3`、双方修改都存在。

## 4. 锁定与在途异步结果

**问题**：隐私解密完成后直接写回密钥、明文并打开视图；备忘录加载也有同类生命周期问题。锁定/退出时迟到的 Promise 仍可能恢复内容。

**修复**：

- 隐私空间增加 `epoch`：解锁、创建、重置、保存都在异步完成后校验代次；锁定时递增代次并清空内存，迟到结果直接丢弃（解锁得到的密钥会先清零）。
- 备忘录增加 `epoch`：加载结果、保存结果在代次变化后不再写回；锁定会重置 loading 状态。
- 工作区同步增加 `sessionSeq`：账号切换/退出后，旧请求不会推进 revision 或修改 dirty 状态。

**回归**：脚本在隐私密码校验期间调用锁定，断言视图保持隐藏、DOM 为空、`isUnlocked()` 为 false。

## 5. 服务端边界

| 问题 | 修复 |
| --- | --- |
| 迁移 advisory lock 在连接池上加锁/解锁可能落在不同连接 | `Migrate` 独占一条 `pgxpool.Conn`，整个迁移和解锁都使用它 |
| 未配置站点地址且代理接受任意 Host，邮件链接可能被 Host 头污染 | 新增 `server.trusted_hosts`：配置后拒绝其他 Host，并为邮件链接提供可信 Host |
| 改密和撤销会话分两步，撤销失败仍返回成功 | 新增 `UpdatePasswordAndRevokeSessions`，在同一事务里改密并删除会话；HTTP 与 CLI 都使用 |
| 管理员缩短会话绝对期限后，旧会话仍可活到旧过期时间 | `Authenticate` 每次按当前绝对期限检查 `created_at + absolute`，超期立即删除会话并 401 |
| PWA 的 HTML 走网络、JS/CSS 命中旧缓存 | Service Worker 改为网络优先、缓存兜底；版本化缓存 `qingdh-shell-v28`；静态资源 URL 带版本参数避免旧 Service Worker 把新 HTML 和旧 CSS/JS 混用；新版本等待用户确认后再接管 |

**服务端回归**：

- `TestTrustedHostGuardAndEmailLinks`：伪造 Host 400；可信 Host 的忘记密码邮件使用可信域名。
- `TestAbsoluteSessionLimitIsDynamic`：把会话创建时间改到 200 天前，断言立即 401。
- 现有密码重置流程测试继续覆盖会话撤销。

## 6. 前端回归脚本

`web-tests/reliability.mjs` 使用 Node 内置 WebSocket + CDP 驱动 headless Chrome，不引入任何前端依赖。CI 的 `web` job 会启动临时 PostgreSQL + 二进制并运行该脚本。

覆盖：保存中编辑、加密冲突、锁定中解密、AI 账号隔离、PWA 缓存版本与边界。
