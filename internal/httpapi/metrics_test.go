package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/XiaoXuRa/qingdh/internal/config"
	"github.com/XiaoXuRa/qingdh/internal/settings"
)

func TestMetricsEndpointRequiresToken(t *testing.T) {
	env := newEnv(t, func(c *config.Config, _ *settings.Values) {
		c.MetricsToken = "metrics-secret"
	})
	c := env.client(t)

	if resp := c.do(http.MethodGet, "/metrics", ""); resp.status != http.StatusUnauthorized {
		t.Fatalf("anonymous metrics = %d %s", resp.status, resp.body)
	}
	resp := c.do(http.MethodGet, "/metrics", "", func(req *http.Request) {
		req.Header.Set("Authorization", "Bearer metrics-secret")
	})
	if resp.status != http.StatusOK {
		t.Fatalf("metrics = %d %s", resp.status, resp.body)
	}
	for _, want := range []string{"qingdh_http_requests_total", "qingdh_db_pool_total"} {
		if !strings.Contains(resp.body, want) {
			t.Fatalf("metrics body missing %q:\n%s", want, resp.body)
		}
	}
}

func TestMetricsDisabledByDefault(t *testing.T) {
	env := newEnv(t, nil)
	if resp := env.client(t).do(http.MethodGet, "/metrics", ""); resp.status != http.StatusNotFound {
		t.Fatalf("disabled metrics = %d", resp.status)
	}
}
