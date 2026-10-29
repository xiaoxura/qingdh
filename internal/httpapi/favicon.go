package httpapi

import (
	"container/list"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	faviconCacheEntries = 128
	faviconMaxBytes     = 96 * 1024
	faviconTTL          = 24 * time.Hour
	faviconErrorTTL     = time.Hour
)

var errPrivateAddress = errors.New("favicon: private address")

type faviconEntry struct {
	data      []byte
	ctype     string
	expiresAt time.Time
	ok        bool
}

type faviconCacheItem struct {
	origin  string
	entry   faviconEntry
	element *list.Element
}

// faviconCache 是带容量上限的 LRU：命中会移到队首，满了淘汰最久未使用的
// 条目，避免旧实现里“随机删一个”导致热门的 favicon 反复回源。
type faviconCache struct {
	mu       sync.Mutex
	entries  map[string]*faviconCacheItem
	order    *list.List
	capacity int
}

func newFaviconCache() *faviconCache {
	return &faviconCache{
		entries:  make(map[string]*faviconCacheItem),
		order:    list.New(),
		capacity: faviconCacheEntries,
	}
}

func (c *faviconCache) get(origin string) (faviconEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	item, ok := c.entries[origin]
	if !ok {
		return faviconEntry{}, false
	}
	if time.Now().After(item.entry.expiresAt) {
		c.removeLocked(item)
		return faviconEntry{}, false
	}
	c.order.MoveToFront(item.element)
	return item.entry, true
}

func (c *faviconCache) put(origin string, entry faviconEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if item, ok := c.entries[origin]; ok {
		item.entry = entry
		c.order.MoveToFront(item.element)
		return
	}
	element := c.order.PushFront(origin)
	c.entries[origin] = &faviconCacheItem{origin: origin, entry: entry, element: element}
	for c.order.Len() > c.capacity {
		oldest := c.order.Back()
		key := oldest.Value.(string)
		c.order.Remove(oldest)
		delete(c.entries, key)
	}
}

func (c *faviconCache) removeLocked(item *faviconCacheItem) {
	c.order.Remove(item.element)
	delete(c.entries, item.origin)
}

// allowedFaviconPort limits the proxy to the default web ports. Without this a
// public host:port could be used to probe arbitrary services through the
// favicon endpoint.
func allowedFaviconPort(scheme, port string) bool {
	switch scheme {
	case "http":
		return port == "" || port == "80"
	case "https":
		return port == "" || port == "443"
	default:
		return false
	}
}

// handleFavicon proxies /favicon.ico through the server so a homepage with
// many bookmarks does not send a request (and the bookmark list) to every
// third-party origin. It only fetches public HTTP(S) origins: the dialer
// resolves again and refuses loopback, private, link-local and multicast IPs
// to keep the endpoint from becoming an SSRF gadget.
func (s *Server) handleFavicon(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow("favicon:"+clientIPFrom(r), 600, 200) {
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return
	}

	raw := strings.TrimSpace(r.URL.Query().Get("u"))
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		http.Error(w, "invalid origin", http.StatusBadRequest)
		return
	}
	if !allowedFaviconPort(parsed.Scheme, parsed.Port()) {
		http.Error(w, "unsupported port", http.StatusBadRequest)
		return
	}
	origin := parsed.Scheme + "://" + parsed.Host

	if entry, ok := s.favicons.get(origin); ok {
		writeFavicon(w, entry)
		return
	}

	// Bound concurrent upstream fetches so a bookmark page cannot open hundreds
	// of sockets at once.
	wait := time.NewTimer(5 * time.Second)
	select {
	case s.faviconSem <- struct{}{}:
		wait.Stop()
		defer func() { <-s.faviconSem }()
	case <-r.Context().Done():
		wait.Stop()
		return
	case <-wait.C:
		http.Error(w, "favicon service busy", http.StatusServiceUnavailable)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	entry := s.fetchFavicon(ctx, origin)
	if !entry.ok {
		entry.expiresAt = time.Now().Add(faviconErrorTTL)
	}
	s.favicons.put(origin, entry)
	writeFavicon(w, entry)
}

func writeFavicon(w http.ResponseWriter, entry faviconEntry) {
	if !entry.ok {
		w.Header().Set("Cache-Control", "public, max-age=3600")
		http.Error(w, "favicon not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", entry.ctype)
	w.Header().Set("Content-Length", strconv.Itoa(len(entry.data)))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(entry.data)
}

func (s *Server) fetchFavicon(ctx context.Context, origin string) faviconEntry {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/favicon.ico", nil)
	if err != nil {
		return faviconEntry{}
	}
	req.Header.Set("User-Agent", "qingdh-favicon/1.0")
	resp, err := s.faviconClient.Do(req)
	if err != nil {
		return faviconEntry{}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.CopyN(io.Discard, resp.Body, 4096)
		return faviconEntry{}
	}
	if resp.ContentLength > faviconMaxBytes {
		return faviconEntry{}
	}
	ctype := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	if !allowedFaviconType(ctype) {
		return faviconEntry{}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, faviconMaxBytes+1))
	if err != nil || len(data) == 0 || len(data) > faviconMaxBytes {
		return faviconEntry{}
	}
	return faviconEntry{data: data, ctype: ctype, expiresAt: time.Now().Add(faviconTTL), ok: true}
}

func allowedFaviconType(ctype string) bool {
	switch ctype {
	case "image/png", "image/x-icon", "image/vnd.microsoft.icon", "image/jpeg", "image/gif", "image/webp", "image/avif":
		return true
	default:
		// SVG is deliberately excluded: serving it from our origin would turn
		// a third-party file into a same-origin document.
		return false
	}
}

func newFaviconClient() *http.Client {
	dialer := &net.Dialer{Timeout: 4 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           safeFaviconDial(dialer),
		TLSHandshakeTimeout:   4 * time.Second,
		ResponseHeaderTimeout: 4 * time.Second,
		ExpectContinueTimeout: time.Second,
		DisableKeepAlives:     true,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   6 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("favicon: too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errPrivateAddress
			}
			return nil
		},
	}
}

func safeFaviconDial(dialer *net.Dialer) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, candidate := range ips {
			if !isPublicIP(candidate.IP) {
				continue
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(candidate.IP.String(), port))
		}
		return nil, errPrivateAddress
	}
}

func isPublicIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() ||
		ip.IsInterfaceLocalMulticast() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		// Carrier-grade NAT, benchmark and reserved blocks.
		if v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
			return false
		}
		if v4[0] == 192 && v4[1] == 0 && v4[2] == 0 {
			return false
		}
		if v4[0] == 198 && (v4[1] == 18 || v4[1] == 19) {
			return false
		}
		if v4[0] >= 240 {
			return false
		}
	}
	return true
}
