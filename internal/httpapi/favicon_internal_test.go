package httpapi

import (
	"net"
	"testing"
	"time"
)

func TestIsPublicIPBlocksPrivateAndReservedRanges(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1",
		"169.254.169.254", "100.64.0.1", "198.18.0.1", "192.0.0.1",
		"0.0.0.0", "::1", "fc00::1", "fe80::1",
	}
	for _, raw := range blocked {
		if isPublicIP(net.ParseIP(raw)) {
			t.Errorf("%s should not be treated as public", raw)
		}
	}
	allowed := []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"}
	for _, raw := range allowed {
		if !isPublicIP(net.ParseIP(raw)) {
			t.Errorf("%s should be public", raw)
		}
	}
}

func TestFaviconPortPolicyOnlyAllowsWebDefaults(t *testing.T) {
	allowed := []struct{ scheme, port string }{
		{"http", ""}, {"http", "80"}, {"https", ""}, {"https", "443"},
	}
	for _, tc := range allowed {
		if !allowedFaviconPort(tc.scheme, tc.port) {
			t.Errorf("%s:%s should be allowed", tc.scheme, tc.port)
		}
	}
	blocked := []struct{ scheme, port string }{
		{"http", "8080"}, {"https", "8443"}, {"http", "443"}, {"https", "80"}, {"ftp", "21"},
	}
	for _, tc := range blocked {
		if allowedFaviconPort(tc.scheme, tc.port) {
			t.Errorf("%s:%s must be rejected", tc.scheme, tc.port)
		}
	}
}

func TestFaviconCacheEvictsLeastRecentlyUsed(t *testing.T) {
	cache := newFaviconCache()
	cache.capacity = 2
	fresh := time.Now().Add(time.Hour)

	cache.put("a", faviconEntry{data: []byte("a"), expiresAt: fresh, ok: true})
	cache.put("b", faviconEntry{data: []byte("b"), expiresAt: fresh, ok: true})
	if _, ok := cache.get("a"); !ok {
		t.Fatal("a should still be cached")
	}
	cache.put("c", faviconEntry{data: []byte("c"), expiresAt: fresh, ok: true})

	if _, ok := cache.get("b"); ok {
		t.Fatal("b should have been evicted as least recently used")
	}
	if _, ok := cache.get("a"); !ok {
		t.Fatal("a should survive because it was read recently")
	}
	if _, ok := cache.get("c"); !ok {
		t.Fatal("c should be cached")
	}
}

func TestFaviconCacheDropsExpiredEntries(t *testing.T) {
	cache := newFaviconCache()
	cache.put("a", faviconEntry{data: []byte("a"), expiresAt: time.Now().Add(-time.Minute), ok: true})
	if _, ok := cache.get("a"); ok {
		t.Fatal("expired entry should not be returned")
	}
	if cache.order.Len() != 0 || len(cache.entries) != 0 {
		t.Fatalf("expired entry should be removed, order=%d entries=%d", cache.order.Len(), len(cache.entries))
	}
}
