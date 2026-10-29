package httpapi

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// limiter is a small in-memory keyed rate limiter. It is intentionally
// per-instance: running several instances weakens the limits, which is
// acceptable for this project and documented in the design notes.
type limiter struct {
	mu      sync.Mutex
	entries map[string]*limiterEntry
	lastGC  time.Time
	now     func() time.Time
}

type limiterEntry struct {
	limiter  *rate.Limiter
	limit    rate.Limit
	burst    int
	lastSeen time.Time
}

func newLimiter() *limiter {
	return &limiter{
		entries: make(map[string]*limiterEntry),
		now:     time.Now,
	}
}

// allow reports whether the key may proceed. perMinute is the sustained rate,
// burst is the bucket size.
func (l *limiter) allow(key string, perMinute float64, burst int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	l.gcLocked(now)

	entry, ok := l.entries[key]
	if !ok || entry.burst != burst {
		entry = &limiterEntry{
			limiter:  rate.NewLimiter(rate.Limit(perMinute/60.0), burst),
			limit:    rate.Limit(perMinute / 60.0),
			burst:    burst,
			lastSeen: now,
		}
		l.entries[key] = entry
	} else {
		entry.lastSeen = now
	}
	return entry.limiter.AllowN(now, 1)
}

// gcLocked drops buckets idle for more than 15 minutes, at most every 5
// minutes, to keep memory bounded.
func (l *limiter) gcLocked(now time.Time) {
	if now.Sub(l.lastGC) < 5*time.Minute {
		return
	}
	l.lastGC = now
	for key, entry := range l.entries {
		if now.Sub(entry.lastSeen) > 15*time.Minute {
			delete(l.entries, key)
		}
	}
}

// Rate limit policies. Values are requests per minute with a burst size.
const (
	limitLoginPerIP    = 20.0
	burstLoginPerIP    = 10
	limitLoginPerEmail = 10.0
	burstLoginPerEmail = 5

	limitRegisterPerIP = 6.0
	burstRegisterPerIP = 3

	limitEmailPerIP    = 6.0
	burstEmailPerIP    = 3
	limitEmailPerEmail = 6.0
	burstEmailPerEmail = 2

	limitVerifyPerIP = 30.0
	burstVerifyPerIP = 10

	// 登录态改密：需要校验当前密码 + Argon2 重算，按用户而不是 IP 限流。
	limitPasswordPerUser = 5.0
	burstPasswordPerUser = 3

	// Encrypted secret sync: memo autosave is debounced, but a burst of edits
	// can still produce several writes per minute.
	limitSecretPerUser = 120.0
	burstSecretPerUser = 30

	// AI proxy: user-borne API keys, so cap bursts and daily volume.
	limitAIChatPerUser = 10.0
	burstAIChatPerUser = 5
	limitAITestPerUser = 6.0
	burstAITestPerUser = 3
	limitAIMetaPerUser = 12.0
	burstAIMetaPerUser = 4
)
