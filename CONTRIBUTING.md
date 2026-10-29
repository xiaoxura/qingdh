# 贡献指南

感谢你愿意改进氢导航。这个项目优先保持**单二进制、零前端构建、可自托管**，提交前请尽量遵守下面的约定。

## 环境

- Go 1.24+
- PostgreSQL 16+（测试默认使用 embedded-postgres，也可以连本机数据库）
- Node.js 22+（只用于前端语法检查、纯函数单测和 CDP 回归）
- 可选：Chrome / Chromium（运行 `web-tests/reliability.mjs`）

## 本地运行

```bash
git clone https://github.com/xiaoxura/qingdh.git
cd qingdh
cp config.example.yml config.yml
chmod 600 config.yml
# 编辑 database.*，然后：
go run ./cmd/qingdh serve -config config.yml
```

打开 `http://localhost:8080`。首次启动会自动迁移数据库。

前端源码在 `web/`，没有打包步骤。开发时在 `config.yml` 中设置：

```yaml
web_dir: "web"
```

修改 `web/` 下的 HTML/CSS/JS 后刷新页面即可；`go:embed` 只在正式构建时打包。

## 提交前检查

```bash
gofmt -l .                 # 应无输出
go vet ./...
go test -race ./...
CGO_ENABLED=0 go build -trimpath -o /tmp/qingdh ./cmd/qingdh

for f in web/*.js web/lib/*.js; do node --check "$f"; done
node --test web-tests/unit/*.test.mjs
```

如果改动涉及浏览器行为，再启动本地服务并运行：

```bash
node web-tests/reliability.mjs
```

回归脚本需要本机服务（默认 `http://127.0.0.1:8080`）和 Chrome，说明见 [`web-tests/README.md`](web-tests/README.md)。

## 代码约定

- 后端保持标准库 `net/http`，不要为了小功能引入框架。
- SQL 集中在 `internal/store/`，迁移按 `migrations/NNNN_*.sql` 递增。
- 新的运行时设置优先放 `settings` 表，启动必需项才放 `config.yml`。
- 前端使用原生 HTML/CSS/JS；共享纯函数放 `web/lib/core.js`，并补 `node:test`。
- 用户可见文案使用中文；日期、时间和错误提示保持和现有风格一致。
- 不要提交 `config.yml`、`TEST_ACCOUNTS.md`、数据库密码、API Key、SMTP 凭据或本地日志。

## 数据库和测试

集成测试会执行 `DROP SCHEMA public CASCADE` 重建 schema。使用专用测试数据库，**不要指向生产库**：

```bash
TEST_DATABASE_URL="postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable" go test ./...
```

不设置时，测试会通过 embedded-postgres 启动临时实例（首次运行需要下载二进制）。

## 提交与 PR

- 一个 PR 尽量只做一件事；附带行为说明和验证方式。
- Bug 修复请尽量补回归测试；前端交互请说明手动验证步骤。
- 提交信息使用简短的祈使句，例如 `fix: 修复 Passkey 在 IP 地址下的提示`。
- 不要在 Issue/PR 中粘贴真实密码、token、Cookie 或用户数据。

## 安全

安全问题请不要公开开 Issue，按 [`SECURITY.md`](SECURITY.md) 的方式私下报告。

## 许可

提交代码即表示同意以 [MIT License](LICENSE) 授权。
