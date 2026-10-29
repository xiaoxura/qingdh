package httpapi_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/XiaoXuRa/qingdh/internal/ai"
	"github.com/XiaoXuRa/qingdh/internal/config"
	"github.com/XiaoXuRa/qingdh/internal/httpapi"
	"github.com/XiaoXuRa/qingdh/internal/settings"
)

// fakeAIUpstream emulates an OpenAI-compatible streaming endpoint.
type fakeAIUpstream struct {
	server    *httptest.Server
	lastKey   string
	lastReq   string
	searchKey string
	searchReq string
	fail      int
}

func newFakeAIUpstream(t *testing.T) *fakeAIUpstream {
	t.Helper()
	fake := &fakeAIUpstream{}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)

		if r.URL.Path == "/models" {
			fake.searchKey = r.Header.Get("Authorization")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"fake-model","name":"Fake Model","context_window":1000,"max_output_tokens":100},{"id":"fake-model-2","name":"Fake Model 2"}]}`))
			return
		}
		if r.URL.Path == "/balance" {
			fake.searchKey = r.Header.Get("Authorization")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}]}`))
			return
		}
		if r.URL.Path == "/search" {
			fake.searchKey = r.Header.Get("Authorization")
			fake.searchReq = string(raw)
			if fake.fail != 0 {
				w.WriteHeader(fake.fail)
				_, _ = w.Write([]byte(`{"error":"bad search key secret-value-123"}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"results":[{"title":"搜索结果标题","url":"https://example.com/result","snippet":"搜索结果摘要","summary":"搜索结果长摘要"}]}`))
			return
		}

		fake.lastKey = r.Header.Get("Authorization")
		fake.lastReq = string(raw)

		if fake.fail != 0 {
			w.WriteHeader(fake.fail)
			// Deliberately echo the key: the proxy must never relay bodies.
			_, _ = w.Write([]byte(`{"error":"bad key secret-value-123"}`))
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"，世界\"},\"finish_reason\":\"stop\"}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":7}}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func aiEnv(t *testing.T, fake *fakeAIUpstream, mutate func(*config.Config, *settings.Values)) *testEnv {
	t.Helper()
	providers := map[string]ai.Provider{
		"fake": {
			ID:           "fake",
			URL:          fake.server.URL,
			Models:       map[string]bool{"fake-model": true},
			DefaultModel: "fake-model",
		},
	}
	return newEnvOpts(t, mutate, httpapi.WithAIProviders(providers))
}

func TestAIChatStreamsThroughProxy(t *testing.T) {
	fake := newFakeAIUpstream(t)
	env := aiEnv(t, fake, nil)
	c := env.client(t)
	registerVerified(t, env, c, "ai@example.com", "correct horse battery")

	resp := c.do(http.MethodPost, "/api/v1/ai/chat", `{
		"provider":"fake",
		"model":"fake-model",
		"apiKey":"test-key-42",
		"query":"今天有什么新闻",
		"history":[{"role":"user","content":"之前的问题"},{"role":"assistant","content":"之前的回答"}]
	}`)
	if resp.status != http.StatusOK {
		t.Fatalf("chat = %d %s", resp.status, resp.body)
	}
	if !strings.HasPrefix(resp.header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("unexpected content type: %s", resp.header.Get("Content-Type"))
	}
	for _, want := range []string{"event: ready", "event: delta", `"text":"你好"`, "，世界", "event: done"} {
		if !strings.Contains(resp.body, want) {
			t.Fatalf("stream missing %q:\n%s", want, resp.body)
		}
	}
	if strings.Contains(resp.body, "test-key-42") || strings.Contains(resp.body, "Authorization") {
		t.Fatalf("proxy response leaked the API key: %s", resp.body)
	}

	if fake.lastKey != "Bearer test-key-42" {
		t.Fatalf("upstream auth header = %q", fake.lastKey)
	}
	for _, want := range []string{`"stream":true`, `"model":"fake-model"`, `今天有什么新闻`, `之前的回答`, `"max_tokens":2048`} {
		if !strings.Contains(fake.lastReq, want) {
			t.Fatalf("upstream request missing %q: %s", want, fake.lastReq)
		}
	}
	if strings.Contains(fake.lastReq, "test-key-42") {
		t.Fatal("API key must not be part of the upstream JSON body")
	}
}

func TestAIChatValidationAndRateLimit(t *testing.T) {
	fake := newFakeAIUpstream(t)
	env := aiEnv(t, fake, nil)
	c := env.client(t)
	registerVerified(t, env, c, "ai-validate@example.com", "correct horse battery")

	// The middleware rate limit is checked before validation and allows a
	// burst of five per user, so keep this list short and reuse one session
	// (registering extra users would hit the registration limiter instead).
	cases := []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{
			name:   "unknown provider",
			body:   `{"provider":"https://evil.example","apiKey":"k","query":"q"}`,
			status: http.StatusUnprocessableEntity,
			code:   "ai_provider_unknown",
		},
		{
			name:   "unknown model",
			body:   `{"provider":"fake","model":"gpt-evil","apiKey":"k","query":"q"}`,
			status: http.StatusUnprocessableEntity,
			code:   "invalid_model",
		},
		{
			name:   "missing key",
			body:   `{"provider":"fake","query":"q"}`,
			status: http.StatusUnprocessableEntity,
			code:   "invalid_api_key",
		},
		{
			name:   "bad history role",
			body:   `{"provider":"fake","apiKey":"k","query":"q","history":[{"role":"system","content":"x"}]}`,
			status: http.StatusUnprocessableEntity,
			code:   "invalid_message",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := c.do(http.MethodPost, "/api/v1/ai/chat", tc.body)
			if resp.status != tc.status {
				t.Fatalf("status = %d, body = %s", resp.status, resp.body)
			}
			if !strings.Contains(resp.body, `"code":"`+tc.code+`"`) {
				t.Fatalf("expected %s, got %s", tc.code, resp.body)
			}
		})
	}

	// Four requests used; the fifth fits the burst, later ones are limited.
	statuses := make([]int, 0, 4)
	for i := 0; i < 4; i++ {
		resp := c.do(http.MethodPost, "/api/v1/ai/chat", `{"provider":"fake","apiKey":"k","query":"q"}`)
		statuses = append(statuses, resp.status)
	}
	sawOK := false
	sawLimited := false
	for _, status := range statuses {
		if status == http.StatusOK {
			sawOK = true
		}
		if status == http.StatusTooManyRequests {
			sawLimited = true
		}
	}
	if !sawOK || !sawLimited {
		t.Fatalf("expected a mix of 200 and 429, got %v", statuses)
	}
}

func TestAIChatDailyLimitAndRedaction(t *testing.T) {
	fake := newFakeAIUpstream(t)
	env := aiEnv(t, fake, func(_ *config.Config, values *settings.Values) {
		values.AIDailyLimit = 1
	})
	c := env.client(t)
	registerVerified(t, env, c, "ai-daily@example.com", "correct horse battery")

	body := `{"provider":"fake","apiKey":"k","query":"q"}`
	if resp := c.do(http.MethodPost, "/api/v1/ai/chat", body); resp.status != http.StatusOK {
		t.Fatalf("first call = %d %s", resp.status, resp.body)
	}
	second := c.do(http.MethodPost, "/api/v1/ai/chat", body)
	if second.status != http.StatusTooManyRequests || !strings.Contains(second.body, "ai_daily_limit") {
		t.Fatalf("daily limit not enforced: %d %s", second.status, second.body)
	}

	// Upstream failures are redacted: the echoed key must never reach the client.
	fake.fail = http.StatusUnauthorized
	third := c.do(http.MethodPost, "/api/v1/ai/test", `{"provider":"fake","apiKey":"secret-value-123"}`)
	if third.status != http.StatusBadGateway {
		t.Fatalf("test endpoint = %d %s", third.status, third.body)
	}
	if strings.Contains(third.body, "secret-value-123") {
		t.Fatalf("upstream body leaked to client: %s", third.body)
	}
	if !strings.Contains(third.body, "upstream_auth") {
		t.Fatalf("expected upstream_auth, got %s", third.body)
	}
}

func TestAITestEndpoint(t *testing.T) {
	fake := newFakeAIUpstream(t)
	env := aiEnv(t, fake, nil)
	c := env.client(t)
	registerVerified(t, env, c, "ai-test@example.com", "correct horse battery")

	resp := c.do(http.MethodPost, "/api/v1/ai/test", `{"provider":"fake","model":"fake-model","apiKey":"test-key"}`)
	if resp.status != http.StatusOK || !strings.Contains(resp.body, `"ok":true`) {
		t.Fatalf("test = %d %s", resp.status, resp.body)
	}
	if fake.lastKey != "Bearer test-key" {
		t.Fatalf("upstream auth = %q", fake.lastKey)
	}

	anonymous := env.client(t).do(http.MethodPost, "/api/v1/ai/test", `{"provider":"fake","apiKey":"x"}`)
	if anonymous.status != http.StatusUnauthorized {
		t.Fatalf("anonymous test = %d", anonymous.status)
	}
}

func TestAIChatUsesSearchAPI(t *testing.T) {
	fake := newFakeAIUpstream(t)
	providers := map[string]ai.Provider{
		"fake-search": {
			ID:           "fake-search",
			URL:          fake.server.URL,
			SearchURL:    fake.server.URL + "/search",
			Models:       map[string]bool{"fake-model": true},
			DefaultModel: "fake-model",
		},
	}
	env := newEnvOpts(t, nil, httpapi.WithAIProviders(providers))
	c := env.client(t)
	registerVerified(t, env, c, "ai-search@example.com", "correct horse battery")

	resp := c.do(http.MethodPost, "/api/v1/ai/chat", `{
		"provider":"fake-search",
		"model":"fake-model",
		"apiKey":"search-key-42",
		"query":"搜索这个主题"
	}`)
	if resp.status != http.StatusOK {
		t.Fatalf("chat = %d %s", resp.status, resp.body)
	}
	for _, want := range []string{"event: sources", `"title":"搜索结果标题"`, "https://example.com/result", "搜索结果长摘要", "event: delta"} {
		if !strings.Contains(resp.body, want) {
			t.Fatalf("stream missing %q:\n%s", want, resp.body)
		}
	}
	if fake.searchKey != "Bearer search-key-42" {
		t.Fatalf("search auth = %q", fake.searchKey)
	}
	for _, want := range []string{`"query":"搜索这个主题"`, `"count":5`, `"need_content":false`} {
		if !strings.Contains(fake.searchReq, want) {
			t.Fatalf("search request missing %q: %s", want, fake.searchReq)
		}
	}
	// The chat completion receives the search result as untrusted context.
	for _, want := range []string{"搜索结果标题", "搜索结果长摘要", "https://example.com/result"} {
		if !strings.Contains(fake.lastReq, want) {
			t.Fatalf("chat request missing search context %q: %s", want, fake.lastReq)
		}
	}
	if strings.Contains(resp.body, "search-key-42") {
		t.Fatalf("stream leaked API key: %s", resp.body)
	}
}

func TestAIModelsBalanceAndUsage(t *testing.T) {
	fake := newFakeAIUpstream(t)
	providers := map[string]ai.Provider{
		"fake-meta": {
			ID:           "fake-meta",
			URL:          fake.server.URL,
			ModelsURL:    fake.server.URL + "/models",
			BalanceURL:   fake.server.URL + "/balance",
			Models:       map[string]bool{"fake-model": true},
			DefaultModel: "fake-model",
		},
	}
	env := newEnvOpts(t, nil, httpapi.WithAIProviders(providers))
	c := env.client(t)
	registerVerified(t, env, c, "ai-meta@example.com", "correct horse battery")

	chat := c.do(http.MethodPost, "/api/v1/ai/chat", `{"provider":"fake-meta","apiKey":"meta-key","query":"q"}`)
	if chat.status != http.StatusOK {
		t.Fatalf("chat = %d %s", chat.status, chat.body)
	}
	models := c.do(http.MethodPost, "/api/v1/ai/models", `{"provider":"fake-meta","apiKey":"meta-key"}`)
	if models.status != http.StatusOK || !strings.Contains(models.body, "fake-model-2") || !strings.Contains(models.body, `"contextWindow":1000`) {
		t.Fatalf("models = %d %s", models.status, models.body)
	}
	balance := c.do(http.MethodPost, "/api/v1/ai/balance", `{"provider":"fake-meta","apiKey":"meta-key"}`)
	if balance.status != http.StatusOK || !strings.Contains(balance.body, `"totalBalance":"110.00"`) || !strings.Contains(balance.body, `"currency":"CNY"`) {
		t.Fatalf("balance = %d %s", balance.status, balance.body)
	}
	if strings.Contains(balance.body, "meta-key") || strings.Contains(models.body, "meta-key") {
		t.Fatal("metadata response leaked the API key")
	}

	usage := c.do(http.MethodGet, "/api/v1/ai/usage", "")
	if usage.status != http.StatusOK {
		t.Fatalf("usage = %d %s", usage.status, usage.body)
	}
	for _, want := range []string{`"provider":"fake-meta"`, `"calls":3`, `"inputTokens":11`, `"outputTokens":7`, `"kind":"balance"`} {
		if !strings.Contains(usage.body, want) {
			t.Fatalf("usage missing %q: %s", want, usage.body)
		}
	}
	if strings.Contains(usage.body, "q") && strings.Contains(usage.body, `"query"`) {
		t.Fatalf("usage must not contain prompt content: %s", usage.body)
	}
}
