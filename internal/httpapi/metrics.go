package httpapi

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/XiaoXuRa/qingdh/internal/metrics"
)

// handleMetrics serves Prometheus text when server.metrics_token is set. With
// no token the route behaves as if it did not exist, so enabling metrics is an
// explicit operator decision.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(s.cfg.MetricsToken)
	if token == "" {
		http.NotFound(w, r)
		return
	}
	provided := ""
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		provided = strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	}
	if provided == "" {
		provided = r.URL.Query().Get("token")
	}
	if subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="metrics"`)
		writeError(w, http.StatusUnauthorized, "unauthorized", "需要指标访问令牌")
		return
	}

	db := metrics.DBStats{}
	if s.store != nil {
		db.Acquired, db.Idle, db.Total, db.Max = s.store.PoolStats()
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	s.metrics.Write(w, db)
}
