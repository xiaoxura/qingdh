package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/XiaoXuRa/qingdh/internal/ai"
	"github.com/XiaoXuRa/qingdh/internal/store"
	"github.com/google/uuid"
)

type aiChatRequest struct {
	Provider  string       `json:"provider"`
	Model     string       `json:"model"`
	APIKey    string       `json:"apiKey"`
	Query     string       `json:"query"`
	History   []ai.Message `json:"history"`
	MaxTokens int          `json:"maxTokens"`
}

// allowAIDaily enforces the per-user daily proxy quota from the ai_usage
// table, so restarts and multiple instances see the same counter. Only
// successful chat calls consume quota; failed upstream calls are still
// recorded for diagnostics but do not lock the user out for the day.
func (s *Server) allowAIDaily(ctx context.Context, userID uuid.UUID) (bool, int) {
	limit := s.settings.Get().AIDailyLimit
	if limit <= 0 {
		limit = 200
	}
	if s.store == nil {
		return true, limit
	}

	now := s.now()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	used, err := s.store.CountAIUsageSince(ctx, userID, "chat", start)
	if err != nil {
		// The quota is a cost control, not an authorization boundary. A
		// database hiccup must not take AI chat down on top of itself.
		s.logger.Warn("count ai usage", "error", err, "user_id", userID.String())
		return true, limit
	}
	return used < limit, limit
}

// writeAIError maps adapter errors to client-safe responses. Upstream bodies
// are never included.
func writeAIError(w http.ResponseWriter, err error) {
	var aiErr *ai.Error
	if errors.As(err, &aiErr) {
		writeError(w, aiErr.Status, aiErr.Code, aiErr.Message)
		return
	}
	writeError(w, http.StatusBadGateway, "ai_upstream_error", "AI 服务暂时不可用，请稍后重试")
}

func (s *Server) recordAIUsage(ctx context.Context, userID uuid.UUID, provider, model, kind, status string, inputTokens, outputTokens int, started time.Time) {
	if s.store == nil {
		return
	}
	rec := store.AIUsageRecord{
		Provider:     provider,
		Model:        model,
		Kind:         kind,
		Status:       status,
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		DurationMS:   int(time.Since(started).Milliseconds()),
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := s.store.RecordAIUsage(ctx, userID, rec); err != nil {
		s.logger.Warn("record ai usage", "error", err, "user_id", userID.String(), "provider", provider)
	}
}

func (s *Server) handleAIChat(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	if !s.limiter.allow("ai:chat:"+user.ID.String(), limitAIChatPerUser, burstAIChatPerUser) {
		w.Header().Set("Retry-After", "30")
		writeError(w, http.StatusTooManyRequests, "rate_limited", "AI 调用太频繁，请稍后再试")
		return
	}

	var req aiChatRequest
	if !decodeJSON(w, r, &req, 64<<10) {
		return
	}

	providerID := strings.TrimSpace(req.Provider)
	provider, ok := s.ai.Provider(providerID)
	if !ok {
		writeError(w, http.StatusUnprocessableEntity, "ai_provider_unknown", "不支持该 AI 供应商")
		return
	}
	model, err := ai.ValidateRequest(provider, req.Model, req.APIKey, req.Query, req.History)
	if err != nil {
		writeAIError(w, err)
		return
	}

	if allowed, limit := s.allowAIDaily(r.Context(), user.ID); !allowed {
		writeError(w, http.StatusTooManyRequests, "ai_daily_limit",
			fmt.Sprintf("今天的 AI 调用次数已用完（上限 %d 次），明天再试或联系管理员调整", limit))
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	rc := http.NewResponseController(w)
	send := func(event string, payload any) error {
		data, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			return marshalErr
		}
		// The server's global WriteTimeout is shorter than a slow search +
		// chat round trip. Extend the per-connection deadline for every SSE
		// event so long answers are not cut off mid-stream.
		_ = rc.SetWriteDeadline(time.Now().Add(2 * time.Minute))
		if _, writeErr := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data); writeErr != nil {
			return writeErr
		}
		return rc.Flush()
	}

	if err := send("ready", map[string]any{"provider": provider.ID, "model": model}); err != nil {
		return
	}

	started := time.Now()
	var usage ai.Usage
	_, err = s.ai.Chat(r.Context(), provider.ID, ai.Request{
		ProviderID: provider.ID,
		Model:      model,
		APIKey:     req.APIKey,
		Query:      req.Query,
		History:    req.History,
		MaxTokens:  req.MaxTokens,
	}, func(text string) error {
		return send("delta", map[string]any{"text": text})
	}, func(sources []ai.Source) error {
		return send("sources", map[string]any{"sources": sources})
	}, func(u ai.Usage) {
		usage = u
	})

	status := "ok"
	s.metrics.IncAIChat()
	if err != nil {
		status = "error"
		s.metrics.IncAIError()
	}
	s.recordAIUsage(r.Context(), user.ID, provider.ID, model, "chat", status, usage.InputTokens, usage.OutputTokens, started)

	if err != nil {
		if r.Context().Err() != nil {
			return // client aborted; nothing left to write
		}
		var aiErr *ai.Error
		if errors.As(err, &aiErr) {
			_ = send("error", map[string]any{"code": aiErr.Code, "message": aiErr.Message})
			return
		}
		s.logger.Error("ai proxy failed", "error", err, "user_id", user.ID.String(), "provider", provider.ID)
		_ = send("error", map[string]any{"code": "ai_upstream_error", "message": "AI 服务暂时不可用"})
		return
	}

	_ = send("done", map[string]any{"provider": provider.ID, "model": model})
}

type aiTestRequest struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	APIKey   string `json:"apiKey"`
}

func (s *Server) handleAITest(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	if !s.limiter.allow("ai:test:"+user.ID.String(), limitAITestPerUser, burstAITestPerUser) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "测试太频繁，请稍后再试")
		return
	}

	var req aiTestRequest
	if !decodeJSON(w, r, &req, 8<<10) {
		return
	}

	providerID := strings.TrimSpace(req.Provider)
	if _, ok := s.ai.Provider(providerID); !ok {
		writeError(w, http.StatusUnprocessableEntity, "ai_provider_unknown", "不支持该 AI 供应商")
		return
	}

	started := time.Now()
	if err := s.ai.Ping(r.Context(), providerID, req.Model, req.APIKey); err != nil {
		s.recordAIUsage(r.Context(), user.ID, providerID, req.Model, "test", "error", 0, 0, started)
		writeAIError(w, err)
		return
	}
	s.recordAIUsage(r.Context(), user.ID, providerID, req.Model, "test", "ok", 0, 0, started)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type aiKeyRequest struct {
	Provider string `json:"provider"`
	APIKey   string `json:"apiKey"`
}

func (s *Server) handleAIModels(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	if !s.limiter.allow("ai:meta:"+user.ID.String(), limitAIMetaPerUser, burstAIMetaPerUser) {
		w.Header().Set("Retry-After", "30")
		writeError(w, http.StatusTooManyRequests, "rate_limited", "请求太频繁，请稍后再试")
		return
	}
	var req aiKeyRequest
	if !decodeJSON(w, r, &req, 8<<10) {
		return
	}
	providerID := strings.TrimSpace(req.Provider)
	if _, ok := s.ai.Provider(providerID); !ok {
		writeError(w, http.StatusUnprocessableEntity, "ai_provider_unknown", "不支持该 AI 供应商")
		return
	}

	started := time.Now()
	models, err := s.ai.Models(r.Context(), providerID, req.APIKey)
	status := "ok"
	if err != nil {
		status = "error"
	}
	s.recordAIUsage(r.Context(), user.ID, providerID, "", "models", status, 0, 0, started)
	if err != nil {
		writeAIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}

func (s *Server) handleAIBalance(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	if !s.limiter.allow("ai:meta:"+user.ID.String(), limitAIMetaPerUser, burstAIMetaPerUser) {
		w.Header().Set("Retry-After", "30")
		writeError(w, http.StatusTooManyRequests, "rate_limited", "请求太频繁，请稍后再试")
		return
	}
	var req aiKeyRequest
	if !decodeJSON(w, r, &req, 8<<10) {
		return
	}
	providerID := strings.TrimSpace(req.Provider)
	if _, ok := s.ai.Provider(providerID); !ok {
		writeError(w, http.StatusUnprocessableEntity, "ai_provider_unknown", "不支持该 AI 供应商")
		return
	}

	started := time.Now()
	balance, err := s.ai.Balance(r.Context(), providerID, req.APIKey)
	status := "ok"
	if err != nil {
		status = "error"
	}
	s.recordAIUsage(r.Context(), user.ID, providerID, "", "balance", status, 0, 0, started)
	if err != nil {
		writeAIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"balance": balance})
}

func (s *Server) handleAIUsage(w http.ResponseWriter, r *http.Request) {
	user, ok := userFrom(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "请先登录")
		return
	}
	if s.store == nil {
		writeError(w, http.StatusServiceUnavailable, "usage_unavailable", "调用统计暂时不可用")
		return
	}
	now := s.now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	summary, err := s.store.AIUsageSummary(r.Context(), user.ID, dayStart)
	if err != nil {
		s.logger.Error("read ai usage", "error", err, "user_id", user.ID.String())
		writeError(w, http.StatusInternalServerError, "usage_failed", "读取调用统计失败")
		return
	}
	writeJSON(w, http.StatusOK, summary)
}
