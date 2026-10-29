package httpapi_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	embeddedpostgres "github.com/fergusstrange/embedded-postgres"

	"github.com/XiaoXuRa/qingdh/internal/auth"
	"github.com/XiaoXuRa/qingdh/internal/config"
	"github.com/XiaoXuRa/qingdh/internal/httpapi"
	"github.com/XiaoXuRa/qingdh/internal/mail"
	"github.com/XiaoXuRa/qingdh/internal/settings"
	"github.com/XiaoXuRa/qingdh/internal/store"
	"github.com/XiaoXuRa/qingdh/migrations"
)

var testStore *store.Store

func TestMain(m *testing.M) {
	os.Exit(runTests(m))
}

func runTests(m *testing.M) int {
	ctx := context.Background()
	dsn := os.Getenv("TEST_DATABASE_URL")

	var pg *embeddedpostgres.EmbeddedPostgres
	if dsn == "" {
		port, err := freePort()
		if err != nil {
			fmt.Fprintln(os.Stderr, "free port:", err)
			return 1
		}
		runtimeDir, err := os.MkdirTemp("", "qingdh-pg-*")
		if err != nil {
			fmt.Fprintln(os.Stderr, "temp dir:", err)
			return 1
		}
		pg = embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
			Port(uint32(port)).
			RuntimePath(runtimeDir).
			Username("postgres").
			Password("postgres").
			Database("postgres").
			Logger(io.Discard))
		if err := pg.Start(); err != nil {
			fmt.Fprintln(os.Stderr, "start embedded postgres:", err)
			return 1
		}
		defer func() {
			_ = pg.Stop()
			_ = os.RemoveAll(runtimeDir)
		}()
		dsn = fmt.Sprintf("postgres://postgres:postgres@127.0.0.1:%d/postgres?sslmode=disable", port)
	}

	st, err := store.Open(ctx, dsn, 10)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open store:", err)
		return 1
	}
	defer st.Close()

	if _, err := st.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); err != nil {
		fmt.Fprintln(os.Stderr, "reset schema:", err)
		return 1
	}
	if err := st.Migrate(ctx, migrations.FS); err != nil {
		fmt.Fprintln(os.Stderr, "migrate:", err)
		return 1
	}

	testStore = st
	return m.Run()
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// testEnv is a running application with a recording mailer.
type testEnv struct {
	server   *httptest.Server
	mailer   *fakeMailer
	store    *store.Store
	settings *settings.Service
}

type fakeMailer struct {
	messages []mail.Message
}

func (f *fakeMailer) Send(_ context.Context, msg mail.Message) error {
	f.messages = append(f.messages, msg)
	return nil
}

func (f *fakeMailer) last() mail.Message {
	if len(f.messages) == 0 {
		return mail.Message{}
	}
	return f.messages[len(f.messages)-1]
}

// newEnv starts an application with a clean database. The callback can adjust
// the startup config and the runtime settings before the server starts.
func newEnv(t *testing.T, mutate func(*config.Config, *settings.Values)) *testEnv {
	t.Helper()
	return newEnvOpts(t, mutate)
}

func newEnvOpts(t *testing.T, mutate func(*config.Config, *settings.Values), opts ...httpapi.Option) *testEnv {
	t.Helper()

	ctx := context.Background()
	if _, err := testStore.Exec(ctx, `TRUNCATE users, sessions, email_tokens, documents, identities, settings CASCADE`); err != nil {
		t.Fatalf("truncate: %v", err)
	}

	cfg := &config.Config{
		ListenAddr: ":0",
		LogLevel:   "error",
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	stg, err := settings.New(ctx, testStore, logger)
	if err != nil {
		t.Fatalf("settings service: %v", err)
	}

	values := settings.Default()
	values.SMTPHost = "smtp.example.com"
	values.SMTPPort = 587
	values.SMTPFrom = "noreply@example.com"
	if mutate != nil {
		mutate(cfg, &values)
	}
	if err := stg.Update(ctx, values); err != nil {
		t.Fatalf("save settings: %v", err)
	}

	m := &fakeMailer{}
	api, err := httpapi.New(cfg, testStore, stg, m, logger, testFS, opts...)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}

	srv := httptest.NewServer(api.Handler())
	t.Cleanup(srv.Close)

	return &testEnv{server: srv, mailer: m, store: testStore, settings: stg}
}

// makeAdmin promotes an existing account.
func (e *testEnv) makeAdmin(t *testing.T, email string) {
	t.Helper()
	user, err := e.store.UserByEmail(context.Background(), email)
	if err != nil {
		t.Fatalf("load user %s: %v", email, err)
	}
	if err := e.store.SetUserAdmin(context.Background(), user.ID, true); err != nil {
		t.Fatalf("set admin: %v", err)
	}
}

// testFS provides the few static files the routes need.
var testFS = fstest.MapFS{
	"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>test</title>")},
	"admin.html": &fstest.MapFile{Data: []byte("<!doctype html><title>admin</title>")},
	"app.js":     &fstest.MapFile{Data: []byte(strings.Repeat("console.log('qingdh');\n", 200))},
	"styles.css": &fstest.MapFile{Data: []byte(strings.Repeat("body { color: #111; }\n", 200))},
}

// client is a cookie-aware HTTP helper bound to a testEnv.
type client struct {
	t      *testing.T
	env    *testEnv
	http   *http.Client
	jar    []*http.Cookie
	device *http.Cookie
}

func (e *testEnv) client(t *testing.T) *client {
	t.Helper()
	return &client{
		t:    t,
		env:  e,
		http: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
}

type response struct {
	status int
	body   string
	header http.Header
}

// verifyEmail performs the POST confirmation used by the real email page.
func (c *client) verifyEmail(token string) response {
	c.t.Helper()
	return c.do(http.MethodPost, "/verify-email", "token="+token, func(req *http.Request) {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	})
}

func (c *client) do(method, path string, body string, opts ...func(*http.Request)) response {
	c.t.Helper()

	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, c.env.server.URL+path, reader)
	if err != nil {
		c.t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Origin", c.env.server.URL)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, cookie := range c.jar {
		req.AddCookie(cookie)
	}
	if c.device != nil {
		req.AddCookie(c.device)
	}
	for _, opt := range opts {
		opt(req)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)

	// Keep the session and device cookies across requests.
	for _, cookie := range resp.Cookies() {
		switch cookie.Name {
		case auth.DeviceCookieName:
			if cookie.MaxAge < 0 {
				c.device = nil
			} else {
				c.device = cookie
			}
		case "qingdh_session", "__Host-qingdh_session":
			if cookie.MaxAge < 0 {
				c.jar = nil
			} else {
				c.jar = []*http.Cookie{cookie}
			}
		}
	}

	return response{status: resp.StatusCode, body: string(raw), header: resp.Header}
}

func (c *client) register(email, password string) response {
	return c.do(http.MethodPost, "/api/v1/auth/register", fmt.Sprintf(`{"email":%q,"password":%q}`, email, password))
}

func (c *client) login(email, password string) response {
	return c.do(http.MethodPost, "/api/v1/auth/login", fmt.Sprintf(`{"email":%q,"password":%q}`, email, password))
}

// verifyToken extracts the token from the last verification email.
func (e *testEnv) verifyToken(t *testing.T) string {
	t.Helper()
	msg := e.mailer.last()
	if msg.Subject == "" {
		t.Fatal("no email was sent")
	}
	idx := strings.Index(msg.Text, "/verify-email?token=")
	if idx == -1 {
		t.Fatalf("verification link missing in mail: %s", msg.Text)
	}
	rest := msg.Text[idx+len("/verify-email?token="):]
	if nl := strings.IndexAny(rest, "\r\n"); nl >= 0 {
		rest = rest[:nl]
	}
	return rest
}
