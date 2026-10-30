# 前端行为回归

零依赖的 headless Chrome 回归脚本，覆盖本轮修复的可靠性问题：

1. **保存中继续编辑**：拦截 PUT `/api/v1/workspace`，延迟期间再编辑，确认第二次编辑会追加提交且最终状态为已同步。
2. **加密冲突**：两个标签页使用同一加密账号，制造 revision 冲突并选择合并，确认加密状态不会丢失、上传仍是 v3 envelope、双方修改都保留。
3. **锁定中解密**：隐私空间密码校验期间手动锁定，确认迟到的解密结果被丢弃，DOM 与内存保持锁定。
4. **账号切换**：AI 配置加载后退出，确认配置、密钥缓存、答案面板全部清理。
5. **PWA 缓存边界**：确认使用版本化 app shell 缓存，且 `/api/`、`/admin` 永不进入 Cache Storage。
6. **懒加载与备忘录**：首屏后动态加载备忘录模块，验证列表搜索，以及 pagehide 时防抖中的正文会被立即提交。
7. **纯函数单测**：`node --test web-tests/unit/*.test.mjs` 覆盖 `js/lib/core.js` 的 URL 校验、转义、时间戳和 favicon 代理地址。

## 前置条件

- 已启动氢导航服务（默认 `http://127.0.0.1:8080`）；
- 允许注册且没有配置 SMTP（仓库默认行为，注册后直接登录）；
- 本机可执行 `google-chrome`（CI 的 Ubuntu runner 自带）。

## 运行

```bash
node web-tests/reliability.mjs
# 或指定实例
BASE=https://nav.example.com node web-tests/reliability.mjs
```

脚本会创建一次性账号，不会清理测试数据；仅建议在本地或 CI 的独立数据库上运行。

## CI

`.github/workflows/ci.yml` 的 `web` job 会启动一个临时 PostgreSQL + 氢导航实例，然后运行本脚本。
