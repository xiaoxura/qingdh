package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
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
