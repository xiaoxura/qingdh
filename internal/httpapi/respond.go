package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/XiaoXuRa/qingdh/internal/auth"
)

// errorBody is the uniform error envelope returned by every API endpoint.
type errorBody struct {
	Error apiError `json:"error"`
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeJSON serializes v with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// The response is already committed; nothing useful remains to do.
		slog.Debug("write json failed", "error", err)
	}
}

// writeError sends the standard error envelope.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Error: apiError{Code: code, Message: message}})
}

// writeErrorWith sends an error envelope plus extra top-level fields.
func writeErrorWith(w http.ResponseWriter, status int, code, message string, extra map[string]any) {
	body := map[string]any{"error": apiError{Code: code, Message: message}}
	for k, v := range extra {
		body[k] = v
	}
	writeJSON(w, status, body)
}

// writePasswordBusy maps the shared Argon2 slot limiter to a retryable 503.
// It returns true when the error was a busy signal, so callers can fall back
// to their normal internal-error handling otherwise.
func writePasswordBusy(w http.ResponseWriter, err error) bool {
	if !errors.Is(err, auth.ErrPasswordBusy) {
		return false
	}
	w.Header().Set("Retry-After", "2")
	writeError(w, http.StatusServiceUnavailable, "server_busy", "服务器繁忙，请稍后再试")
	return true
}
