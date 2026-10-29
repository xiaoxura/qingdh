package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

const minimal = `
server:
  listen: ":9000"
database:
  host: db.internal
  port: 5433
  user: qingdh
  password: "p@ss word"
  name: nav
`

func TestLoadDatabaseFields(t *testing.T) {
	cfg, err := Load(writeConfig(t, minimal))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.ListenAddr != ":9000" {
		t.Fatalf("listen = %q", cfg.ListenAddr)
	}
	if cfg.Database.Host != "db.internal" || cfg.Database.Port != 5433 {
		t.Fatalf("db = %+v", cfg.Database)
	}
	if cfg.Database.User != "qingdh" || cfg.Database.Password != "p@ss word" || cfg.Database.Name != "nav" {
		t.Fatalf("db = %+v", cfg.Database)
	}
	if cfg.Database.SSLMode != "prefer" {
		t.Fatalf("sslmode = %q", cfg.Database.SSLMode)
	}
	if cfg.Database.MaxConns != 10 {
		t.Fatalf("max conns = %d", cfg.Database.MaxConns)
	}
	if !cfg.Database.MigrateOnStart {
		t.Fatal("migrate_on_start should default to true")
	}

	dsn := cfg.Database.DSN()
	if !strings.HasPrefix(dsn, "postgres://") || !strings.Contains(dsn, "db.internal:5433") {
		t.Fatalf("dsn = %q", dsn)
	}
	if !strings.Contains(dsn, "sslmode=prefer") {
		t.Fatalf("dsn without sslmode: %q", dsn)
	}
	if !strings.Contains(dsn, "p%40ss%20word") {
		t.Fatalf("password not escaped in dsn: %q", dsn)
	}
}

func TestLoadDatabaseDefaults(t *testing.T) {
	cfg, err := Load(writeConfig(t, `
server: {}
database:
  host: 127.0.0.1
  user: postgres
  name: qingdh
`))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Database.Port != 5432 {
		t.Fatalf("port = %d", cfg.Database.Port)
	}
	if !strings.Contains(cfg.Database.DSN(), "postgres://postgres@127.0.0.1:5432/qingdh") {
		t.Fatalf("dsn = %q", cfg.Database.DSN())
	}
	if cfg.Database.MaxConns != 10 {
		t.Fatalf("max conns = %d", cfg.Database.MaxConns)
	}
}

func TestLoadMissingDatabaseFields(t *testing.T) {
	cases := []string{
		"database:\n  user: u\n  name: n\n",
		"database:\n  host: h\n  name: n\n",
		"database:\n  host: h\n  user: u\n",
	}
	for i, body := range cases {
		if _, err := Load(writeConfig(t, body)); err == nil {
			t.Fatalf("case %d should fail", i)
		}
	}
}

func TestLoadRejectsInvalidValues(t *testing.T) {
	cases := []string{
		"database:\n  host: h\n  port: 70000\n  user: u\n  name: n\n",
		"database:\n  host: h\n  user: u\n  name: n\n  max_conns: 1000\n",
		"database:\n  host: h\n  user: u\n  name: n\n  sslmode: sometimes\n",
		"server:\n  trusted_proxies: [\"nope\"]\ndatabase:\n  host: h\n  user: u\n  name: n\n",
		"log_level: loud\ndatabase:\n  host: h\n  user: u\n  name: n\n",
		"database:\n  host: h\n  user: u\n  name: n\nunknown: 1\n",
	}
	for i, body := range cases {
		if _, err := Load(writeConfig(t, body)); err == nil {
			t.Fatalf("case %d should fail", i)
		}
	}
}

func TestRelativeWebDir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	body := "database:\n  host: h\n  user: u\n  name: n\nweb_dir: ../web\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if want := filepath.Join(dir, "../web"); cfg.WebDir != want {
		t.Fatalf("web dir = %q, want %q", cfg.WebDir, want)
	}
}

func TestResolvePath(t *testing.T) {
	t.Setenv("QINGDH_CONFIG", "/tmp/env.yml")
	if got := ResolvePath(""); got != "/tmp/env.yml" {
		t.Fatalf("got %q", got)
	}
	if got := ResolvePath("/tmp/flag.yml"); got != "/tmp/flag.yml" {
		t.Fatalf("flag should win, got %q", got)
	}
}

func TestLoadTrustedHosts(t *testing.T) {
	cfg, err := Load(writeConfig(t, `
server:
  trusted_hosts:
    - " Nav.Example.com "
    - "nav.example.com:8443"
    - "nav.example.com"
database:
  host: 127.0.0.1
  user: postgres
  name: qingdh
`))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(cfg.TrustedHosts) != 2 {
		t.Fatalf("trusted hosts = %#v", cfg.TrustedHosts)
	}
	if cfg.TrustedHosts[0] != "nav.example.com" || cfg.TrustedHosts[1] != "nav.example.com:8443" {
		t.Fatalf("trusted hosts = %#v", cfg.TrustedHosts)
	}

	for _, bad := range []string{"https://nav.example.com", "nav.example.com/path", "nav.example.com?x=1"} {
		if _, err := Load(writeConfig(t, `
server:
  trusted_hosts: ["`+bad+`"]
database:
  host: 127.0.0.1
  user: postgres
  name: qingdh
`)); err == nil {
			t.Fatalf("expected %q to be rejected", bad)
		}
	}
}
