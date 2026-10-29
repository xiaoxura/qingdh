// Package config loads the startup configuration from config.yml.
//
// The file intentionally contains only what is required to boot the process:
// where to listen and how to reach PostgreSQL. The public URL, registration,
// email verification, SMTP and session lifetimes are runtime settings managed
// in /admin.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// DefaultPath is looked up in the working directory when -config is omitted.
const DefaultPath = "config.yml"

// Config is the resolved startup configuration.
type Config struct {
	// ConfigPath is the file the values were read from.
	ConfigPath string

	ListenAddr     string
	TrustedProxies []netip.Prefix
	// TrustedHosts, when non-empty, restricts the HTTP Host header and is used
	// to build absolute email links when no site URL is configured.
	TrustedHosts []string

	Database Database

	LogLevel string
	// WebDir serves the frontend from disk instead of the embedded copy. It is
	// resolved relative to the configuration file.
	WebDir string
	// MetricsToken enables GET /metrics when non-empty. The endpoint is
	// disabled otherwise, so an upgrade never exposes metrics unexpectedly.
	MetricsToken string
}

// Database holds the connection fields. They are assembled into a DSN at
// runtime, so operators never have to embed credentials in a URL.
type Database struct {
	Host           string
	Port           int
	User           string
	Password       string
	Name           string
	SSLMode        string
	MaxConns       int
	MigrateOnStart bool
}

// DSN builds the PostgreSQL connection string.
func (d Database) DSN() string {
	u := &url.URL{
		Scheme: "postgres",
		Host:   net.JoinHostPort(d.Host, strconv.Itoa(d.Port)),
		Path:   "/" + d.Name,
	}
	if d.Password != "" {
		u.User = url.UserPassword(d.User, d.Password)
	} else {
		u.User = url.User(d.User)
	}
	query := url.Values{}
	query.Set("sslmode", d.SSLMode)
	u.RawQuery = query.Encode()
	return u.String()
}

type fileConfig struct {
	Server struct {
		Listen         string   `yaml:"listen"`
		TrustedProxies []string `yaml:"trusted_proxies"`
		TrustedHosts   []string `yaml:"trusted_hosts"`
		MetricsToken   string   `yaml:"metrics_token"`
	} `yaml:"server"`

	Database struct {
		Host           string `yaml:"host"`
		Port           int    `yaml:"port"`
		User           string `yaml:"user"`
		Password       string `yaml:"password"`
		Name           string `yaml:"name"`
		SSLMode        string `yaml:"sslmode"`
		MaxConns       int    `yaml:"max_conns"`
		MigrateOnStart *bool  `yaml:"migrate_on_start"`
	} `yaml:"database"`

	LogLevel string `yaml:"log_level"`
	WebDir   string `yaml:"web_dir"`
}

// normalizeHost validates an allowed Host value such as "nav.example.com" or
// "nav.example.com:8443" and returns a lower-case canonical form.
func normalizeHost(raw string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" {
		return "", errors.New("不能为空")
	}
	if strings.Contains(value, "://") || strings.ContainsAny(value, "/?#@") {
		return "", errors.New("只能填写主机名，可带端口")
	}
	parsed, err := url.Parse("http://" + value)
	if err != nil || parsed.Host == "" || parsed.Path != "" {
		return "", errors.New("主机名格式不正确")
	}
	host := parsed.Host
	if strings.HasSuffix(host, ":") {
		return "", errors.New("端口不能为空")
	}
	return host, nil
}

// ResolvePath returns the configuration file path from the -config flag, the
// QINGDH_CONFIG environment variable or the default location.
func ResolvePath(flagValue string) string {
	if strings.TrimSpace(flagValue) != "" {
		return flagValue
	}
	if env := strings.TrimSpace(os.Getenv("QINGDH_CONFIG")); env != "" {
		return env
	}
	return DefaultPath
}

// Load reads and validates the configuration file.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("配置文件不存在：%s（可从 config.example.yml 复制一份）", path)
		}
		return nil, fmt.Errorf("读取配置文件失败：%w", err)
	}

	var fc fileConfig
	decoder := yaml.NewDecoder(strings.NewReader(string(raw)))
	decoder.KnownFields(true)
	if err := decoder.Decode(&fc); err != nil {
		return nil, fmt.Errorf("解析 %s 失败：%w", path, err)
	}

	cfg := &Config{
		ConfigPath:   path,
		ListenAddr:   strings.TrimSpace(fc.Server.Listen),
		LogLevel:     strings.ToLower(strings.TrimSpace(fc.LogLevel)),
		WebDir:       strings.TrimSpace(fc.WebDir),
		MetricsToken: strings.TrimSpace(fc.Server.MetricsToken),
		Database: Database{
			Host:           strings.TrimSpace(fc.Database.Host),
			Port:           fc.Database.Port,
			User:           strings.TrimSpace(fc.Database.User),
			Password:       fc.Database.Password,
			Name:           strings.TrimSpace(fc.Database.Name),
			SSLMode:        strings.ToLower(strings.TrimSpace(fc.Database.SSLMode)),
			MaxConns:       fc.Database.MaxConns,
			MigrateOnStart: true,
		},
	}
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = ":8080"
	}
	if cfg.LogLevel == "" {
		cfg.LogLevel = "info"
	}
	switch cfg.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return nil, fmt.Errorf("log_level 只能是 debug、info、warn 或 error")
	}
	if fc.Database.MigrateOnStart != nil {
		cfg.Database.MigrateOnStart = *fc.Database.MigrateOnStart
	}

	db := &cfg.Database
	if db.Host == "" {
		return nil, fmt.Errorf("database.host 不能为空")
	}
	if db.Port == 0 {
		db.Port = 5432
	}
	if db.Port < 1 || db.Port > 65535 {
		return nil, fmt.Errorf("database.port 必须在 1-65535 之间")
	}
	if db.User == "" {
		return nil, fmt.Errorf("database.user 不能为空")
	}
	if db.Name == "" {
		return nil, fmt.Errorf("database.name 不能为空")
	}
	if db.SSLMode == "" {
		db.SSLMode = "prefer"
	}
	switch db.SSLMode {
	case "disable", "allow", "prefer", "require", "verify-ca", "verify-full":
	default:
		return nil, fmt.Errorf("database.sslmode 只能是 disable、allow、prefer、require、verify-ca 或 verify-full")
	}
	if db.MaxConns <= 0 {
		db.MaxConns = 10
	}
	if db.MaxConns > 100 {
		return nil, fmt.Errorf("database.max_conns 不能超过 100")
	}

	seenHosts := map[string]bool{}
	for _, raw := range fc.Server.TrustedHosts {
		host, err := normalizeHost(raw)
		if err != nil {
			return nil, fmt.Errorf("server.trusted_hosts 中的 %q 不合法：%w", raw, err)
		}
		if seenHosts[host] {
			continue
		}
		seenHosts[host] = true
		cfg.TrustedHosts = append(cfg.TrustedHosts, host)
	}

	for _, part := range fc.Server.TrustedProxies {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(part)
		if err != nil {
			return nil, fmt.Errorf("server.trusted_proxies 中的 %q 不是 CIDR", part)
		}
		cfg.TrustedProxies = append(cfg.TrustedProxies, prefix.Masked())
	}

	if cfg.WebDir != "" && !filepath.IsAbs(cfg.WebDir) {
		cfg.WebDir = filepath.Join(filepath.Dir(path), cfg.WebDir)
	}

	return cfg, nil
}
