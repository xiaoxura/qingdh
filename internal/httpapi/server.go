// Package httpapi wires the HTTP routes of the application: account
// management, document sync and the embedded frontend.
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"github.com/XiaoXuRa/qingdh/internal/ai"
	"github.com/XiaoXuRa/qingdh/internal/auth"
	"github.com/XiaoXuRa/qingdh/internal/config"
	"github.com/XiaoXuRa/qingdh/internal/mail"
	"github.com/XiaoXuRa/qingdh/internal/metrics"
	"github.com/XiaoXuRa/qingdh/internal/settings"
	"github.com/XiaoXuRa/qingdh/internal/store"
)

// maxDocumentBytes bounds the synced navigation document. Encrypted
// envelopes carry Base64, so the limit has some headroom over the 256 KiB
// plaintext budget.
const maxDocumentBytes = 512 * 1024

// Server holds the dependencies shared by all handlers.
type Server struct {
	cfg           *config.Config
	store         *store.Store
	settings      *settings.Service
	mailer        mail.Mailer
	sessions      *auth.SessionManager
	logger        *slog.Logger
	static        fs.FS
	staticFS      http.Handler
	limiter       *limiter
	now           func() time.Time
	version       string
	ai            *ai.Service
	metrics       *metrics.Registry
	favicons      *faviconCache
	faviconClient *http.Client
	faviconSem    chan struct{}

	// dummyHash is verified for unknown accounts so that login timing does not
	// reveal whether an email exists.
	dummyHash string
}

// Option customises the server; used by tests to point the AI adapter at a
// local upstream.
type Option func(*Server)

// WithVersion records the build version for the admin UI and diagnostics.
func WithVersion(version string) Option {
	return func(s *Server) {
		if version != "" {
			s.version = version
		}
	}
}

// WithAIProviders replaces the proxy provider allowlist.
func WithAIProviders(providers map[string]ai.Provider) Option {
	return func(s *Server) {
		s.ai.Providers = providers
	}
}

// WithAIHTTPClient replaces the outbound HTTP client used by the AI proxy.
func WithAIHTTPClient(client *http.Client) Option {
	return func(s *Server) {
		if client != nil {
			s.ai.HTTP = client
		}
	}
}

// New builds the HTTP server. staticFS must contain index.html at its root.
func New(cfg *config.Config, st *store.Store, stg *settings.Service, mailer mail.Mailer, logger *slog.Logger, staticFS fs.FS, opts ...Option) (*Server, error) {
	dummy, err := auth.HashPassword("dummy-password-for-timing")
	if err != nil {
		return nil, fmt.Errorf("prepare dummy hash: %w", err)
	}

	server := &Server{
		cfg:           cfg,
		store:         st,
		settings:      stg,
		mailer:        mailer,
		logger:        logger,
		static:        staticFS,
		limiter:       newLimiter(),
		now:           time.Now,
		version:       "dev",
		dummyHash:     dummy,
		ai:            ai.New(),
		metrics:       metrics.New(),
		favicons:      newFaviconCache(),
		faviconClient: newFaviconClient(),
		faviconSem:    make(chan struct{}, 8),
	}
	if cfg.WebDir != "" {
		// Development keeps reading from disk so edits appear on refresh.
		server.staticFS = devStaticHandler(staticFS)
	} else {
		bundle, err := newStaticBundle(staticFS)
		if err != nil {
			return nil, fmt.Errorf("prepare static assets: %w", err)
		}
		server.staticFS = bundle
	}
	for _, opt := range opts {
		opt(server)
	}
	server.sessions = auth.NewSessionManager(st, func() (time.Duration, time.Duration, time.Duration) {
		return stg.Get().Durations()
	})
	return server, nil
}

// Handler returns the root HTTP handler with middleware applied.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /readyz", s.handleReadyz)
	mux.HandleFunc("GET /metrics", s.handleMetrics)

	mux.HandleFunc("POST /api/v1/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/v1/auth/me", s.requireAuth(s.handleMe))
	mux.HandleFunc("POST /api/v1/auth/refresh", s.requireAuth(s.handleRefresh))
	mux.HandleFunc("POST /api/v1/auth/password", s.requireAuth(s.handleChangePassword))
	mux.HandleFunc("POST /api/v1/auth/email-change", s.requireAuth(s.handleRequestEmailChange))
	mux.HandleFunc("GET /change-email", s.handleChangeEmailPage)
	mux.HandleFunc("POST /change-email", s.handleChangeEmailForm)

	mux.HandleFunc("POST /api/v1/auth/verify-email", s.handleVerifyEmail)
	mux.HandleFunc("GET /verify-email", s.handleVerifyEmailPage)
	mux.HandleFunc("POST /verify-email", s.handleVerifyEmailForm)
	mux.HandleFunc("POST /api/v1/auth/resend-verification", s.handleResendVerification)
	mux.HandleFunc("POST /api/v1/auth/forgot-password", s.handleForgotPassword)
	mux.HandleFunc("POST /api/v1/auth/reset-password", s.handleResetPassword)

	mux.HandleFunc("GET /api/v1/auth/sessions", s.requireAuth(s.handleListSessions))
	mux.HandleFunc("DELETE /api/v1/auth/sessions/{id}", s.requireAuth(s.handleDeleteSession))
	mux.HandleFunc("POST /api/v1/auth/logout-all", s.requireAuth(s.handleLogoutAll))

	mux.HandleFunc("DELETE /api/v1/account", s.requireAuth(s.handleDeleteAccount))
	mux.HandleFunc("GET /api/v1/account/export", s.requireAuth(s.handleExport))

	mux.HandleFunc("GET /api/v1/workspace", s.requireAuth(s.handleGetWorkspace))
	mux.HandleFunc("GET /api/v1/workspace/revisions", s.requireAuth(s.handleListWorkspaceRevisions))
	mux.HandleFunc("GET /api/v1/workspace/revisions/{revision}", s.requireAuth(s.handleGetWorkspaceRevision))
	mux.HandleFunc("PUT /api/v1/workspace", s.requireAuth(s.handlePutWorkspace))
	mux.HandleFunc("POST /api/v1/workspace/disable-encryption", s.requireAuth(s.handleDisableEncryption))

	mux.HandleFunc("GET /api/v1/site", s.handleSiteInfo)
	mux.HandleFunc("GET /api/favicon", s.handleFavicon)
	mux.HandleFunc("GET /ai", s.handleAppPage)
	mux.HandleFunc("GET /ai/", s.handleAppPage)

	mux.HandleFunc("GET /api/v1/secrets/{kind}", s.requireAuth(s.handleGetSecret))
	mux.HandleFunc("PUT /api/v1/secrets/{kind}", s.requireAuth(s.handlePutSecret))
	mux.HandleFunc("DELETE /api/v1/secrets/{kind}", s.requireAuth(s.handleDeleteSecret))

	mux.HandleFunc("POST /api/v1/ai/chat", s.requireAuth(s.handleAIChat))
	mux.HandleFunc("POST /api/v1/ai/test", s.requireAuth(s.handleAITest))
	mux.HandleFunc("POST /api/v1/ai/models", s.requireAuth(s.handleAIModels))
	mux.HandleFunc("POST /api/v1/ai/balance", s.requireAuth(s.handleAIBalance))
	mux.HandleFunc("GET /api/v1/ai/usage", s.requireAuth(s.handleAIUsage))

	mux.HandleFunc("GET /api/v1/admin/overview", s.requireAdmin(s.handleAdminOverview))
	mux.HandleFunc("GET /api/v1/admin/audit", s.requireAdmin(s.handleAdminAudit))
	mux.HandleFunc("GET /api/v1/admin/settings", s.requireAdmin(s.handleGetAdminSettings))
	mux.HandleFunc("PUT /api/v1/admin/settings", s.requireAdmin(s.handlePutAdminSettings))
	mux.HandleFunc("POST /api/v1/admin/settings/test-email", s.requireAdmin(s.handleTestEmail))
	mux.HandleFunc("GET /api/v1/admin/users", s.requireAdmin(s.handleListAdminUsers))
	mux.HandleFunc("GET /api/v1/admin/users/{id}/workspace", s.requireAdmin(s.handleAdminUserWorkspace))
	mux.HandleFunc("PATCH /api/v1/admin/users/{id}", s.requireAdmin(s.handleUpdateAdminUser))
	mux.HandleFunc("DELETE /api/v1/admin/users/{id}", s.requireAdmin(s.handleDeleteAdminUser))

	mux.HandleFunc("GET /admin", s.handleAdminPage)
	mux.HandleFunc("GET /admin/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/admin", http.StatusSeeOther)
	})
	mux.Handle("/", s.staticHandler())

	handler := recoverer(s.logger)(requestID(logging(s.logger, s.metrics, s.securityHeaders(
		s.hostGuard(clientIP(s.cfg.TrustedProxies)(s.sameOriginGuard(s.requireJSON(mux)))),
	))))
	return handler
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "ok\n")
}

func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 3*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, "database unavailable\n")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "ready\n")
}

// servePage reuses the embedded asset bundle for SPA entry points so /ai and
// /admin also get ETag validation and gzip instead of a raw ReadFile.
func (s *Server) servePage(w http.ResponseWriter, r *http.Request, name string) bool {
	bundle, ok := s.staticFS.(*staticBundle)
	if !ok {
		return false
	}
	clone := r.Clone(r.Context())
	clone.URL.Path = "/" + name
	bundle.ServeHTTP(w, clone)
	return true
}

// handleAppPage serves the SPA shell for client-side routes such as /ai.
func (s *Server) handleAppPage(w http.ResponseWriter, r *http.Request) {
	if s.servePage(w, r, "index.html") {
		return
	}
	raw, err := fs.ReadFile(s.static, "index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// handleAdminPage serves the admin single page.
func (s *Server) handleAdminPage(w http.ResponseWriter, r *http.Request) {
	if s.servePage(w, r, "admin.html") {
		return
	}
	raw, err := fs.ReadFile(s.static, "admin.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// staticHandler serves the embedded (or on-disk in development) frontend.
func (s *Server) staticHandler() http.Handler {
	return s.staticFS
}

// decodeJSON reads a size-limited JSON body and rejects trailing garbage.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any, maxBytes int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体过大")
			return false
		}
		writeError(w, http.StatusBadRequest, "invalid_json", "请求体不是有效的 JSON")
		return false
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求体只能包含一个 JSON 对象")
		return false
	}
	return true
}
