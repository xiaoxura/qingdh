package httpapi_test

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestWorkspaceConditionalGet(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "etag-workspace@example.com", "correct horse battery")

	payload := `{"version":2,"groups":[{"id":"g1","name":"常用","links":[]}]}`
	if resp := putDocument(t, c, 0, payload); resp.status != http.StatusOK {
		t.Fatalf("put = %d %s", resp.status, resp.body)
	}

	first := c.do(http.MethodGet, "/api/v1/workspace", "")
	if first.status != http.StatusOK || first.header.Get("ETag") == "" {
		t.Fatalf("first get = %d etag=%q", first.status, first.header.Get("ETag"))
	}
	etag := first.header.Get("ETag")

	conditional := c.do(http.MethodGet, "/api/v1/workspace", "", func(req *http.Request) {
		req.Header.Set("If-None-Match", etag)
	})
	if conditional.status != http.StatusNotModified || conditional.body != "" {
		t.Fatalf("conditional get = %d %q", conditional.status, conditional.body)
	}

	// 新 revision 必须让旧 ETag 失效。
	if resp := putDocument(t, c, 1, payload); resp.status != http.StatusOK {
		t.Fatalf("second put = %d %s", resp.status, resp.body)
	}
	changed := c.do(http.MethodGet, "/api/v1/workspace", "", func(req *http.Request) {
		req.Header.Set("If-None-Match", etag)
	})
	if changed.status != http.StatusOK || changed.header.Get("ETag") == etag {
		t.Fatalf("stale etag = %d etag=%q", changed.status, changed.header.Get("ETag"))
	}
}

func TestSecretConditionalGet(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "etag-secret@example.com", "correct horse battery")

	if resp := c.do(http.MethodPut, "/api/v1/secrets/memo",
		fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, testDataKeyEnvelope("memo"))); resp.status != http.StatusOK {
		t.Fatalf("put memo = %d %s", resp.status, resp.body)
	}

	first := c.do(http.MethodGet, "/api/v1/secrets/memo", "")
	etag := first.header.Get("ETag")
	if first.status != http.StatusOK || etag == "" {
		t.Fatalf("first get = %d etag=%q", first.status, etag)
	}
	conditional := c.do(http.MethodGet, "/api/v1/secrets/memo", "", func(req *http.Request) {
		req.Header.Set("If-None-Match", etag)
	})
	if conditional.status != http.StatusNotModified {
		t.Fatalf("conditional secret = %d %s", conditional.status, conditional.body)
	}

	if resp := c.do(http.MethodPut, "/api/v1/secrets/memo",
		fmt.Sprintf(`{"baseRevision":1,"payload":%s}`, testDataKeyEnvelope("memo"))); resp.status != http.StatusOK {
		t.Fatalf("update memo = %d %s", resp.status, resp.body)
	}
	changed := c.do(http.MethodGet, "/api/v1/secrets/memo", "", func(req *http.Request) {
		req.Header.Set("If-None-Match", etag)
	})
	if changed.status != http.StatusOK || changed.header.Get("ETag") == etag {
		t.Fatalf("stale secret etag = %d etag=%q", changed.status, changed.header.Get("ETag"))
	}
}

func TestSiteConditionalGetRefreshesLogoOnlyWhenSettingsChange(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "etag-site@example.com", "correct horse battery")
	env.makeAdmin(t, "etag-site@example.com")

	first := admin.do(http.MethodGet, "/api/v1/site", "")
	etag := first.header.Get("ETag")
	if first.status != http.StatusOK || etag == "" {
		t.Fatalf("site = %d etag=%q", first.status, etag)
	}
	if cache := first.header.Get("Cache-Control"); !strings.Contains(cache, "must-revalidate") {
		t.Fatalf("site should be revalidatable, cache=%q", cache)
	}
	conditional := admin.do(http.MethodGet, "/api/v1/site", "", func(req *http.Request) {
		req.Header.Set("If-None-Match", etag)
	})
	if conditional.status != http.StatusNotModified {
		t.Fatalf("conditional site = %d %s", conditional.status, conditional.body)
	}

	if resp := admin.do(http.MethodPut, "/api/v1/admin/settings", `{"siteName":"新的名字"}`); resp.status != http.StatusOK {
		t.Fatalf("update settings = %d %s", resp.status, resp.body)
	}
	changed := admin.do(http.MethodGet, "/api/v1/site", "", func(req *http.Request) {
		req.Header.Set("If-None-Match", etag)
	})
	if changed.status != http.StatusOK || !strings.Contains(changed.body, "新的名字") || changed.header.Get("ETag") == etag {
		t.Fatalf("site after settings change = %d %s (etag %q)", changed.status, changed.body, changed.header.Get("ETag"))
	}
}
