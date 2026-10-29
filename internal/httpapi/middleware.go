package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/XiaoXuRa/qingdh/internal/auth"
	"github.com/XiaoXuRa/qingdh/internal/metrics"
	"github.com/XiaoXuRa/qingdh/internal/store"
)

type contextKey string

const (
	ctxKeyRequestID contextKey = "request_id"
	ctxKeyUser      contextKey = "user"
	ctxKeySession   contextKey = "session"
	ctxKeyClientIP  contextKey = "client_ip"
)

// recoverer turns panics into 500 responses instead of killing the process.
func recoverer(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					logger.Error("panic recovered", "path", r.URL.Path, "panic", rec)
					writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// requestID attaches an identifier that is echoed in the response and logs.
func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := auth.NewRequestID()
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKeyRequestID, id)))
	})
}

// statusRecorder captures the response status for logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wrote {
		s.status = code
		s.wrote = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if !s.wrote {
		s.status = http.StatusOK
		s.wrote = true
	}
	return s.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the underlying writer so that SSE
// handlers can flush through the logging middleware.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func logging(logger *slog.Logger, reg *metrics.Registry, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		elapsed := time.Since(start)
		if reg != nil {
			reg.ObserveRequest(r.Method, rec.status, elapsed)
		}

		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			return
		}
		attrs := []any{
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", elapsed.Milliseconds(),
			"request_id", r.Context().Value(ctxKeyRequestID),
		}
		if u, ok := userFrom(r.Context()); ok {
			attrs = append(attrs, "user_id", u.ID.String())
		}
		switch {
		case rec.status >= 500:
			logger.Error("request", attrs...)
		case isQuietStaticPath(r.URL.Path):
			// Assets are numerous and uninteresting; keep the info log focused
			// on pages and API calls.
			logger.Debug("request", attrs...)
		default:
			logger.Info("request", attrs...)
		}
	})
}

func isQuietStaticPath(path string) bool {
	if path == "/api/favicon" {
		return true
	}
	if strings.HasPrefix(path, "/api/") {
		return false
	}
	switch path {
	case "/", "/ai", "/ai/", "/admin", "/admin/", "/verify-email", "/metrics", "/healthz", "/readyz":
		return false
	}
	return true
}

// securityHeaders applies conservative defaults for a first-party app.
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' https: data:; connect-src 'self' https:; font-src 'self'; " +
		"worker-src 'self'; manifest-src 'self'; " +
		"base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		if s.requestSecure(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP resolves the caller address, honouring X-Forwarded-For only from
// trusted proxies.
func clientIP(trusted []netip.Prefix) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := remoteIP(r.RemoteAddr)
			if isTrusted(ip, trusted) {
				if forwarded := forwardedFor(r); forwarded != "" {
					ip = forwarded
				}
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKeyClientIP, ip)))
		})
	}
}

func remoteIP(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}

func isTrusted(ip string, prefixes []netip.Prefix) bool {
	if len(prefixes) == 0 {
		return false
	}
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}
	for _, prefix := range prefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// forwardedFor returns the right-most address that is not a trusted proxy.
func forwardedFor(r *http.Request) string {
	raw := r.Header.Get("X-Forwarded-For")
	if raw == "" {
		return ""
	}
	parts := strings.Split(raw, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		candidate := strings.TrimSpace(parts[i])
		if candidate == "" {
			continue
		}
		if net.ParseIP(candidate) == nil {
			return ""
		}
		return candidate
	}
	return ""
}

// hostTrusted reports whether the request Host is in the configured allowlist.
// An empty allowlist keeps the previous behaviour (accept any Host).
func (s *Server) hostTrusted(host string) bool {
	if len(s.cfg.TrustedHosts) == 0 {
		return true
	}
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" {
		return false
	}
	hostWithoutPort := host
	if name, _, err := net.SplitHostPort(host); err == nil {
		hostWithoutPort = name
	}
	for _, allowed := range s.cfg.TrustedHosts {
		if host == allowed {
			return true
		}
		// 允许配置不带端口的主机名匹配带端口的请求 Host。
		if !strings.Contains(allowed, ":") && hostWithoutPort == allowed {
			return true
		}
	}
	return false
}

// hostGuard rejects requests whose Host header is not explicitly trusted. This
// prevents Host-header poisoning of verification / reset email links on
// deployments that accept arbitrary Host values.
func (s *Server) hostGuard(next http.Handler) http.Handler {
	if len(s.cfg.TrustedHosts) == 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.hostTrusted(r.Host) {
			writeError(w, http.StatusBadRequest, "invalid_host", "请求的 Host 不被允许")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// sameOriginGuard blocks cross-site state changes. Browsers send Origin on
// non-GET requests, so a mismatch is rejected. The canonical base URL (when
// configured in /admin) and the origin of the current request are both
// accepted; non-browser clients that send neither Origin nor Referer are
// allowed, which keeps curl usable.
func (s *Server) sameOriginGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}

		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = r.Header.Get("Referer")
		}
		if origin != "" {
			parsed, err := url.Parse(origin)
			if err != nil || parsed.Host == "" {
				writeError(w, http.StatusForbidden, "cross_origin", "请求来源不被允许")
				return
			}
			got := parsed.Scheme + "://" + parsed.Host
			allowed := s.requestOrigin(r)
			if base := s.settings.Get().BaseURLValue(); base != nil {
				if got == base.Scheme+"://"+base.Host || got == allowed {
					next.ServeHTTP(w, r)
					return
				}
			} else if got == allowed {
				next.ServeHTTP(w, r)
				return
			}
			writeError(w, http.StatusForbidden, "cross_origin", "请求来源不被允许")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ensureDeviceID returns this browser's stable device identifier, setting the
// long-lived cookie when it is missing or malformed.
func (s *Server) ensureDeviceID(w http.ResponseWriter, r *http.Request) string {
	if cookie, err := r.Cookie(auth.DeviceCookieName); err == nil && auth.ValidDeviceID(cookie.Value) {
		return cookie.Value
	}
	id, err := auth.NewDeviceID()
	if err != nil {
		s.logger.Warn("generate device id", "error", err)
		return ""
	}
	http.SetCookie(w, auth.DeviceCookie(id, s.requestSecure(r)))
	return id
}

// requestSecure reports whether the request reached the server over HTTPS,
// honouring X-Forwarded-Proto only from trusted proxies.
// requestTransportSecure reports whether this specific connection reached us
// over TLS (or a trusted proxy said so). It intentionally ignores the
// configured site URL, which describes the canonical public origin but must
// not rewrite what the current request actually used.
func (s *Server) requestTransportSecure(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if isTrusted(remoteIP(r.RemoteAddr), s.cfg.TrustedProxies) {
		proto := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
		if strings.EqualFold(proto, "https") {
			return true
		}
	}
	return false
}

func (s *Server) requestSecure(r *http.Request) bool {
	if s.requestTransportSecure(r) {
		return true
	}
	// A canonical HTTPS site URL means cookies must be marked Secure even
	// when TLS terminates at a proxy that is not listed in trusted_proxies.
	if base := s.settings.Get().BaseURLValue(); base != nil && base.Scheme == "https" {
		return true
	}
	return false
}

// requestOrigin is the scheme://host actually used by the incoming request.
func (s *Server) requestOrigin(r *http.Request) string {
	scheme := "http"
	if s.requestTransportSecure(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// errMailBaseURL 表示既没有配置站点地址，也没有可信 Host 可用于邮件链接。
var errMailBaseURL = errors.New("httpapi: no trusted base URL for email links")

// mailBaseURL returns the canonical URL for links in emails. A request Host is
// never trusted on its own: without a configured site URL or trusted_hosts an
// attacker could poison verification/reset links by forging the Host header.
// Callers must treat errMailBaseURL as "do not send" and tell the operator to
// set the site address.
func (s *Server) mailBaseURL(r *http.Request) (*url.URL, error) {
	if base := s.settings.Get().BaseURLValue(); base != nil {
		return base, nil
	}
	if len(s.cfg.TrustedHosts) == 0 {
		return nil, errMailBaseURL
	}
	scheme := "http"
	if s.requestTransportSecure(r) {
		scheme = "https"
	}
	host := s.cfg.TrustedHosts[0]
	if s.hostTrusted(r.Host) {
		host = strings.ToLower(strings.TrimSpace(r.Host))
	}
	return &url.URL{Scheme: scheme, Host: host}, nil
}

// requireJSON enforces a JSON body on state-changing requests that carry one.
func (s *Server) requireJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The email verification page submits a normal HTML form, not JSON.
		if r.Method == http.MethodPost && r.URL.Path == "/verify-email" {
			next.ServeHTTP(w, r)
			return
		}
		switch r.Method {
		case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
			if r.ContentLength == 0 {
				next.ServeHTTP(w, r)
				return
			}
			ct := r.Header.Get("Content-Type")
			if mediaType(ct) != "application/json" {
				writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "请求必须是 application/json")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func mediaType(contentType string) string {
	if idx := strings.IndexByte(contentType, ';'); idx >= 0 {
		contentType = contentType[:idx]
	}
	return strings.ToLower(strings.TrimSpace(contentType))
}

// requireAuth resolves the session cookie and injects the user into context.
// It renews the cookie when the sliding window advanced.
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := s.sessions.ReadToken(r, s.requestSecure(r))
		sess, user, renewed, err := s.sessions.Authenticate(r.Context(), token)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
				return
			}
			s.logger.Error("authenticate failed", "error", err)
			writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误")
			return
		}
		if user.DisabledAt != nil {
			_ = s.store.DeleteSession(r.Context(), sess.ID)
			s.clearSessionCookies(w)
			writeError(w, http.StatusForbidden, "account_disabled", "账号已被管理员禁用")
			return
		}

		if renewed != nil {
			http.SetCookie(w, s.sessions.Cookie(token, *renewed, s.requestSecure(r)))
		}

		ctx := context.WithValue(r.Context(), ctxKeyUser, user)
		ctx = context.WithValue(ctx, ctxKeySession, sess)
		next(w, r.WithContext(ctx))
	}
}

func userFrom(ctx context.Context) (store.User, bool) {
	u, ok := ctx.Value(ctxKeyUser).(store.User)
	return u, ok
}

func sessionFrom(ctx context.Context) (store.Session, bool) {
	s, ok := ctx.Value(ctxKeySession).(store.Session)
	return s, ok
}

// requireAdmin restricts a handler to administrators.
func (s *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		user, ok := userFrom(r.Context())
		if !ok || !user.IsAdmin {
			writeError(w, http.StatusForbidden, "forbidden", "需要管理员权限")
			return
		}
		next(w, r)
	})
}

// clearSessionCookies removes both cookie variants.
func (s *Server) clearSessionCookies(w http.ResponseWriter) {
	for _, cookie := range s.sessions.ClearCookies() {
		http.SetCookie(w, cookie)
	}
}
