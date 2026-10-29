// Command qingdh runs the navigation service: an embedded frontend, account
// management, document sync and an admin backend.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	assets "github.com/XiaoXuRa/qingdh"
	"github.com/XiaoXuRa/qingdh/internal/auth"
	"github.com/XiaoXuRa/qingdh/internal/config"
	"github.com/XiaoXuRa/qingdh/internal/httpapi"
	"github.com/XiaoXuRa/qingdh/internal/mail"
	"github.com/XiaoXuRa/qingdh/internal/settings"
	"github.com/XiaoXuRa/qingdh/internal/store"
	"github.com/XiaoXuRa/qingdh/migrations"
)

// version is overridden at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	command := "serve"
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}

	switch command {
	case "serve":
		return serve(args)
	case "migrate":
		return migrateOnly(args)
	case "user":
		return userCommand(args)
	case "admin":
		return adminCommand(args)
	case "version", "-v", "--version":
		fmt.Println("qingdh " + version)
		return nil
	case "help", "-h", "--help":
		printUsage()
		return nil
	default:
		printUsage()
		return fmt.Errorf("unknown command %q", command)
	}
}

func printUsage() {
	fmt.Fprint(os.Stderr, `qingdh - self-hosted navigation start page

Usage:
  qingdh [serve] [flags]               启动 HTTP 服务（默认命令）
  qingdh migrate [flags]               执行数据库迁移后退出
  qingdh user create <email> [flags]   创建已验证账号（终端输入密码）
  qingdh user passwd <email> [flags]   重置密码并撤销全部会话
  qingdh admin grant <email> [flags]   设为管理员
  qingdh admin revoke <email> [flags]  取消管理员
  qingdh version                       打印版本

Flags:
  -config <path>   配置文件路径，默认 ./config.yml，也可用 QINGDH_CONFIG 指定

配置只包含启动必需项（监听地址、BASE_URL、数据库、代理、日志、开发用 web 目录）；
注册、邮箱验证、SMTP、会话时长等在管理后台 /admin 中修改。
`)
}

// extractConfig pulls -config/--config out of any position so that commands
// such as "user create email -config ./x.yml" work as expected.
func extractConfig(args []string) (path string, rest []string) {
	rest = make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-config" || arg == "--config":
			if i+1 < len(args) {
				path = args[i+1]
				i++
				continue
			}
		case strings.HasPrefix(arg, "-config="):
			path = strings.TrimPrefix(arg, "-config=")
			continue
		case strings.HasPrefix(arg, "--config="):
			path = strings.TrimPrefix(arg, "--config=")
			continue
		}
		rest = append(rest, arg)
	}
	path = config.ResolvePath(path)
	return path, rest
}

func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
	slog.SetDefault(logger)
	return logger
}

func loadConfig(path string) (*config.Config, *slog.Logger, error) {
	cfg, err := config.Load(path)
	if err != nil {
		return nil, nil, err
	}
	return cfg, newLogger(cfg.LogLevel), nil
}

func openStore(ctx context.Context, cfg *config.Config) (*store.Store, error) {
	return store.Open(ctx, cfg.Database.DSN(), cfg.Database.MaxConns)
}

func logSettingsWarnings(logger *slog.Logger, values settings.Values, trustedHosts []string) {
	if values.BaseURL == "" {
		logger.Warn("站点地址未设置，将根据请求自动识别；建议在管理后台设置站点地址")
	}
	if !values.SMTPConfigured() && values.RequireEmailVerification {
		logger.Warn("SMTP 未配置，邮箱验证已自动关闭；可在 /admin 中配置 SMTP")
	}
	if values.SMTPConfigured() && values.BaseURL == "" && len(trustedHosts) == 0 {
		logger.Warn("SMTP 已配置，但站点地址与 server.trusted_hosts 都为空；邮件链接无法安全生成，验证/找回邮件将不发送")
	}
	if values.SMTPConfigured() && values.SMTPUsername != "" && values.SMTPTLS == "none" {
		logger.Warn("SMTP 使用明文连接，凭据会以明文发送")
	}
	if values.AllowRegistration && !values.VerificationRequired() {
		logger.Warn("开放注册且无需邮箱验证，任何人都可以创建账号")
	}
	if len(strings.TrimSpace(values.BaseURL)) > 0 && strings.HasPrefix(strings.ToLower(values.BaseURL), "https://") {
		logger.Info("站点地址使用 HTTPS；请确认反向代理传递 X-Forwarded-Proto")
	}
}

// logProxyWarnings points out the most common reverse-proxy misconfiguration:
// TLS or a proxy in front of the app without trusted_proxies. In that state
// every client shares the proxy address for rate limiting, and Secure cookie
// detection cannot use X-Forwarded-Proto.
func logProxyWarnings(logger *slog.Logger, cfg *config.Config, values settings.Values) {
	if len(cfg.TrustedProxies) > 0 {
		return
	}
	if len(cfg.TrustedHosts) > 0 || strings.HasPrefix(strings.ToLower(values.BaseURL), "https://") {
		logger.Warn("已配置可信域名或 HTTPS 站点地址，但 server.trusted_proxies 为空；" +
			"反向代理后的限流会按代理 IP 合并，请补充代理 CIDR")
	}
}

func migrateOnly(args []string) error {
	path, _ := extractConfig(args)
	cfg, _, err := loadConfig(path)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	st, err := openStore(ctx, cfg)
	if err != nil {
		return err
	}
	defer st.Close()

	if err := st.Migrate(ctx, migrations.FS); err != nil {
		return err
	}
	fmt.Println("migrations applied")
	return nil
}

func userCommand(args []string) error {
	path, rest := extractConfig(args)
	if len(rest) < 2 {
		printUsage()
		return errors.New("用法: qingdh user <create|passwd> <email> [-config path]")
	}
	action, email := rest[0], rest[1]

	cfg, _, err := loadConfig(path)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	st, err := openStore(ctx, cfg)
	if err != nil {
		return err
	}
	defer st.Close()

	normalized, err := auth.NormalizeEmail(email)
	if err != nil {
		return err
	}
	if err := st.Migrate(ctx, migrations.FS); err != nil {
		return err
	}

	switch action {
	case "create":
		password, err := promptPassword("Password: ")
		if err != nil {
			return err
		}
		if err := auth.ValidatePassword(password); err != nil {
			return err
		}
		hash, err := auth.HashPassword(password)
		if err != nil {
			return err
		}
		user, err := st.CreateUser(ctx, normalized, hash)
		if err != nil {
			return err
		}
		if _, err := st.MarkEmailVerified(ctx, user.ID, time.Now()); err != nil {
			return err
		}
		fmt.Printf("created %s (%s)\n", user.Email, user.ID)
		return nil

	case "passwd":
		password, err := promptPassword("New password: ")
		if err != nil {
			return err
		}
		if err := auth.ValidatePassword(password); err != nil {
			return err
		}
		hash, err := auth.HashPassword(password)
		if err != nil {
			return err
		}
		user, err := st.UserByEmail(ctx, normalized)
		if err != nil {
			return err
		}
		if err := st.UpdatePasswordAndRevokeSessions(ctx, user.ID, hash); err != nil {
			return err
		}
		fmt.Printf("password updated for %s\n", user.Email)
		return nil

	default:
		printUsage()
		return fmt.Errorf("unknown user command %q", action)
	}
}

func adminCommand(args []string) error {
	path, rest := extractConfig(args)
	if len(rest) < 2 {
		printUsage()
		return errors.New("用法: qingdh admin <grant|revoke> <email> [-config path]")
	}
	action, email := rest[0], rest[1]
	if action != "grant" && action != "revoke" {
		printUsage()
		return fmt.Errorf("unknown admin command %q", action)
	}

	cfg, _, err := loadConfig(path)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	st, err := openStore(ctx, cfg)
	if err != nil {
		return err
	}
	defer st.Close()

	normalized, err := auth.NormalizeEmail(email)
	if err != nil {
		return err
	}
	user, err := st.UserByEmail(ctx, normalized)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("用户 %s 不存在，请先用 qingdh user create 创建", normalized)
		}
		return err
	}

	enable := action == "grant"
	if err := st.SetUserAdmin(ctx, user.ID, enable); err != nil {
		return err
	}
	if enable {
		fmt.Printf("%s 现在是管理员\n", user.Email)
	} else {
		fmt.Printf("%s 已取消管理员权限\n", user.Email)
	}
	return nil
}

func promptPassword(prompt string) (string, error) {
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, prompt)
		raw, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return "", err
		}
		return string(raw), nil
	}

	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func serve(args []string) error {
	path, rest := extractConfig(args)
	if len(rest) > 0 {
		printUsage()
		return fmt.Errorf("serve 不接受位置参数: %s", strings.Join(rest, " "))
	}

	cfg, logger, err := loadConfig(path)
	if err != nil {
		return err
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	startCtx, cancel := context.WithTimeout(rootCtx, 30*time.Second)
	defer cancel()

	st, err := openStore(startCtx, cfg)
	if err != nil {
		return err
	}
	defer st.Close()

	if cfg.Database.MigrateOnStart {
		if err := st.Migrate(startCtx, migrations.FS); err != nil {
			return fmt.Errorf("apply migrations: %w", err)
		}
	}

	settingsService, err := settings.New(startCtx, st, logger)
	if err != nil {
		return err
	}
	logSettingsWarnings(logger, settingsService.Get(), cfg.TrustedHosts)
	logProxyWarnings(logger, cfg, settingsService.Get())
	go settingsService.StartRefresher(rootCtx, 30*time.Second)

	var staticFS fs.FS = assets.Files
	if cfg.WebDir != "" {
		staticFS = os.DirFS(cfg.WebDir)
		logger.Info("serving frontend from disk", "dir", cfg.WebDir)
	}

	mailer := mail.NewDynamic(func() (mail.SMTPConfig, bool) {
		values := settingsService.Get()
		if !values.SMTPConfigured() {
			return mail.SMTPConfig{}, false
		}
		return values.SMTPConfig(), true
	}, logger)
	// Registration and password reset enqueue mail instead of waiting for an
	// SMTP round trip inside the HTTP handler.
	mailQueue := mail.NewQueue(mailer, logger, 2)
	mailQueue.Start(rootCtx)
	defer mailQueue.Close()

	api, err := httpapi.New(cfg, st, settingsService, mailQueue, logger, staticFS, httpapi.WithVersion(version))
	if err != nil {
		return err
	}

	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	cleanupDone := make(chan struct{})
	go func() {
		defer close(cleanupDone)
		cleanupLoop(rootCtx, st, logger)
	}()

	errCh := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", cfg.ListenAddr, "config", cfg.ConfigPath)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		stop()
		<-cleanupDone
		return err
	case <-rootCtx.Done():
		logger.Info("shutting down")
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutdownCancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		// Live SSE streams can outlast the grace period. That is a normal
		// restart, not a failed process: report it and still exit cleanly so
		// orchestrators do not restart-loop on a healthy shutdown.
		logger.Warn("shutdown timed out; closing remaining connections", "error", err)
		_ = server.Close()
	}
	<-cleanupDone
	logger.Info("stopped")
	return nil
}

// cleanupLoop periodically drops expired sessions and stale tokens.
func cleanupLoop(ctx context.Context, st *store.Store, logger *slog.Logger) {
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()

	runOnce := func() {
		runCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()

		sessions, err := st.DeleteExpiredSessions(runCtx)
		if err != nil {
			logger.Warn("cleanup sessions failed", "error", err)
		}
		tokens, err := st.DeleteExpiredTokens(runCtx)
		if err != nil {
			logger.Warn("cleanup tokens failed", "error", err)
		}
		aiUsage, err := st.DeleteOldAIUsage(runCtx, 90*24*time.Hour)
		if err != nil {
			logger.Warn("cleanup ai usage failed", "error", err)
		}
		audit, err := st.DeleteOldAudit(runCtx, 365*24*time.Hour)
		if err != nil {
			logger.Warn("cleanup audit failed", "error", err)
		}
		revisions, err := st.PruneDocumentRevisions(runCtx, 20, 30*24*time.Hour)
		if err != nil {
			logger.Warn("cleanup document revisions failed", "error", err)
		}
		if sessions > 0 || tokens > 0 || aiUsage > 0 || audit > 0 || revisions > 0 {
			logger.Info("cleanup", "sessions", sessions, "email_tokens", tokens, "ai_usage", aiUsage, "audit", audit, "document_revisions", revisions)
		}
	}

	runOnce()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runOnce()
		}
	}
}

var _ fs.FS = assets.Files
