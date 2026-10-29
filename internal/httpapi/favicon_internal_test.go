package httpapi

import (
	"net"
	"testing"
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
