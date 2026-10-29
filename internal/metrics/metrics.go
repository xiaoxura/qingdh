// Package metrics exposes a small, dependency-free Prometheus text endpoint.
// It intentionally keeps labels low-cardinality (method and status only) and
// never records paths, user IDs or document contents.
package metrics

import (
	"fmt"
	"io"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Registry accumulates process-local counters. A multi-instance deployment
// scrapes each instance independently.
type Registry struct {
	mu       sync.RWMutex
	requests map[string]*atomic.Int64
	total    atomic.Int64
	duration atomic.Int64 // microseconds
	aiChats  atomic.Int64
	aiErrors atomic.Int64
}

// New returns an empty registry.
func New() *Registry {
	return &Registry{requests: make(map[string]*atomic.Int64)}
}

// ObserveRequest records one completed HTTP request.
func (r *Registry) ObserveRequest(method string, status int, duration time.Duration) {
	key := method + "|" + strconv.Itoa(status)
	r.mu.RLock()
	counter := r.requests[key]
	r.mu.RUnlock()
	if counter == nil {
		r.mu.Lock()
		counter = r.requests[key]
		if counter == nil {
			counter = &atomic.Int64{}
			r.requests[key] = counter
		}
		r.mu.Unlock()
	}
	counter.Add(1)
	r.total.Add(1)
	r.duration.Add(duration.Microseconds())
}

// IncAIChat counts one proxied chat request.
func (r *Registry) IncAIChat() { r.aiChats.Add(1) }

// IncAIError counts one failed proxied AI call.
func (r *Registry) IncAIError() { r.aiErrors.Add(1) }

// DBStats is a snapshot of the pgx pool.
type DBStats struct {
	Acquired int32
	Idle     int32
	Total    int32
	Max      int32
}

// Write renders the Prometheus text exposition format.
func (r *Registry) Write(w io.Writer, db DBStats) {
	r.mu.RLock()
	keys := make([]string, 0, len(r.requests))
	for key := range r.requests {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	fmt.Fprintln(w, "# HELP qingdh_http_requests_total HTTP requests by method and status.")
	fmt.Fprintln(w, "# TYPE qingdh_http_requests_total counter")
	for _, key := range keys {
		method, status, _ := splitKey(key)
		fmt.Fprintf(w, "qingdh_http_requests_total{method=%q,status=%q} %d\n", method, status, r.requests[key].Load())
	}
	r.mu.RUnlock()

	fmt.Fprintln(w, "# HELP qingdh_http_request_duration_seconds_sum Total request duration.")
	fmt.Fprintln(w, "# TYPE qingdh_http_request_duration_seconds_sum counter")
	fmt.Fprintf(w, "qingdh_http_request_duration_seconds_sum %s\n", seconds(r.duration.Load()))
	fmt.Fprintln(w, "# HELP qingdh_http_request_duration_seconds_count Completed requests.")
	fmt.Fprintln(w, "# TYPE qingdh_http_request_duration_seconds_count counter")
	fmt.Fprintf(w, "qingdh_http_request_duration_seconds_count %d\n", r.total.Load())

	fmt.Fprintln(w, "# HELP qingdh_ai_chat_requests_total Proxied AI chat requests.")
	fmt.Fprintln(w, "# TYPE qingdh_ai_chat_requests_total counter")
	fmt.Fprintf(w, "qingdh_ai_chat_requests_total %d\n", r.aiChats.Load())
	fmt.Fprintln(w, "# HELP qingdh_ai_upstream_errors_total Failed proxied AI calls.")
	fmt.Fprintln(w, "# TYPE qingdh_ai_upstream_errors_total counter")
	fmt.Fprintf(w, "qingdh_ai_upstream_errors_total %d\n", r.aiErrors.Load())

	fmt.Fprintln(w, "# HELP qingdh_db_pool_acquired Currently acquired database connections.")
	fmt.Fprintln(w, "# TYPE qingdh_db_pool_acquired gauge")
	fmt.Fprintf(w, "qingdh_db_pool_acquired %d\n", db.Acquired)
	fmt.Fprintln(w, "# HELP qingdh_db_pool_idle Idle database connections.")
	fmt.Fprintln(w, "# TYPE qingdh_db_pool_idle gauge")
	fmt.Fprintf(w, "qingdh_db_pool_idle %d\n", db.Idle)
	fmt.Fprintln(w, "# HELP qingdh_db_pool_total Total database connections.")
	fmt.Fprintln(w, "# TYPE qingdh_db_pool_total gauge")
	fmt.Fprintf(w, "qingdh_db_pool_total %d\n", db.Total)
	fmt.Fprintln(w, "# HELP qingdh_db_pool_max Maximum database connections.")
	fmt.Fprintln(w, "# TYPE qingdh_db_pool_max gauge")
	fmt.Fprintf(w, "qingdh_db_pool_max %d\n", db.Max)
}

func splitKey(key string) (method, status string, ok bool) {
	for i := 0; i < len(key); i++ {
		if key[i] == '|' {
			return key[:i], key[i+1:], true
		}
	}
	return key, "", false
}

func seconds(micros int64) string {
	return strconv.FormatFloat(float64(micros)/1e6, 'f', 6, 64)
}
