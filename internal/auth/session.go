package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/XiaoXuRa/qingdh/internal/store"
)

// TTLs returns the current sliding session lifetimes. It is read from the
// admin settings on every use so changes apply without a restart.
type TTLs func() (idle, absolute, renew time.Duration)

const (
	cookieName       = "qingdh_session"
	cookieNameSecure = "__Host-qingdh_session"
	// DeviceCookieName identifies a browser across logins. It is deliberately
	// separate from the session so the device list can reuse one row.
	DeviceCookieName = "qingdh_device"
	deviceIDBytes    = 16
	deviceCookieAge  = 365 * 24 * time.Hour
)

// NewDeviceID returns a random opaque device identifier.
func NewDeviceID() (string, error) {
	raw := make([]byte, deviceIDBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// ValidDeviceID reports whether value looks like an ID produced by NewDeviceID.
func ValidDeviceID(value string) bool {
	if len(value) != deviceIDBytes*2 {
		return false
	}
	for _, char := range value {
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}

// DeviceCookie stores a long-lived browser identity.
func DeviceCookie(id string, secure bool) *http.Cookie {
	return &http.Cookie{
		Name:     DeviceCookieName,
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(deviceCookieAge),
		MaxAge:   int(deviceCookieAge.Seconds()),
	}
}

// SessionManager creates, validates and renews browser sessions.
type SessionManager struct {
	store *store.Store
	ttls  TTLs
	now   func() time.Time
}

// NewSessionManager wires a session manager.
func NewSessionManager(st *store.Store, ttls TTLs) *SessionManager {
	return &SessionManager{store: st, ttls: ttls, now: time.Now}
}

// Started is the result of creating a session.
type Started struct {
	Token   string
	Session store.Session
}

// Start creates a new session and returns the raw token that belongs in the
// cookie. The raw token is never persisted.
func (m *SessionManager) Start(ctx context.Context, userID uuid.UUID, deviceID, userAgent, ip string) (Started, error) {
	raw, hash, err := NewToken()
	if err != nil {
		return Started{}, err
	}
	idleTTL, _, _ := m.ttls()
	expiresAt := m.now().Add(idleTTL)
	sess, err := m.store.UpsertSession(ctx, userID, deviceID, hash, truncate(userAgent, 300), truncate(ip, 64), expiresAt)
	if err != nil {
		return Started{}, err
	}
	return Started{Token: raw, Session: sess}, nil
}

// Authenticate resolves a raw cookie token to a session and user. When the
// session is due for renewal, the new expiry is returned so the caller can
// refresh the cookie.
func (m *SessionManager) Authenticate(ctx context.Context, rawToken string) (store.Session, store.User, *time.Time, error) {
	if rawToken == "" {
		return store.Session{}, store.User{}, nil, store.ErrNotFound
	}
	sess, user, err := m.store.SessionByTokenHash(ctx, HashToken(rawToken))
	if err != nil {
		return store.Session{}, store.User{}, nil, err
	}
	idleTTL, absoluteTTL, renewAfter := m.ttls()
	// 绝对期限在每次认证时按当前设置检查：管理员缩短上限后，旧会话
	// 不能继续活到创建时的旧过期时间。
	if !m.now().Before(sess.CreatedAt.Add(absoluteTTL)) {
		_ = m.store.DeleteSession(ctx, sess.ID)
		return store.Session{}, store.User{}, nil, store.ErrNotFound
	}
	newExpiry, err := m.store.RenewSession(ctx, sess.ID, idleTTL, absoluteTTL, renewAfter)
	if err != nil {
		// A failed renewal must not log the user out; report the error but keep
		// the session usable.
		return sess, user, nil, err
	}
	return sess, user, newExpiry, nil
}

// Cookie builds the session cookie for the given expiry. Secure cookies use
// the __Host- prefix, which browsers only accept over HTTPS.
func (m *SessionManager) Cookie(token string, expiresAt time.Time, secure bool) *http.Cookie {
	maxAge := int(time.Until(expiresAt).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	name := cookieName
	if secure {
		name = cookieNameSecure
	}
	return &http.Cookie{
		Name:     name,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
		MaxAge:   maxAge,
	}
}

// ClearCookies expires both the secure and the plain cookie, so switching
// between HTTP and HTTPS cannot leave a stale session behind.
func (m *SessionManager) ClearCookies() []*http.Cookie {
	expired := func(name string, secure bool) *http.Cookie {
		return &http.Cookie{
			Name:     name,
			Value:    "",
			Path:     "/",
			HttpOnly: true,
			Secure:   secure,
			SameSite: http.SameSiteLaxMode,
			Expires:  time.Unix(0, 0),
			MaxAge:   -1,
		}
	}
	return []*http.Cookie{expired(cookieName, false), expired(cookieNameSecure, true)}
}

// ReadToken extracts the raw session token from a request. The cookie that
// matches the current scheme wins, with a fallback to the other name so that
// a scheme change does not log users out.
func (m *SessionManager) ReadToken(r *http.Request, secure bool) string {
	preferred, fallback := cookieName, cookieNameSecure
	if secure {
		preferred, fallback = cookieNameSecure, cookieName
	}
	if cookie, err := r.Cookie(preferred); err == nil && cookie.Value != "" {
		return cookie.Value
	}
	if cookie, err := r.Cookie(fallback); err == nil {
		return cookie.Value
	}
	return ""
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	// Cut on a rune boundary to keep the value valid UTF-8.
	cut := s[:max]
	for len(cut) > 0 && cut[len(cut)-1]&0xC0 == 0x80 {
		cut = cut[:len(cut)-1]
	}
	return cut
}
