package httpapi

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// staticBundle serves the embedded frontend with content-based validators and
// pre-compressed bodies. Files are immutable at runtime, so everything is
// prepared once when the server starts instead of on every request.
type staticBundle struct {
	files map[string]*staticAsset
}

type staticAsset struct {
	raw         []byte
	gzip        []byte
	etag        string
	contentType string
}

// newStaticBundle reads every regular file below fsys and prepares an ETag and
// a gzip variant for compressible text assets. The bundle keeps the files in
// memory; the embedded frontend is only a few hundred KiB.
func newStaticBundle(fsys fs.FS) (*staticBundle, error) {
	bundle := &staticBundle{files: make(map[string]*staticAsset)}
	err := fs.WalkDir(fsys, ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		raw, err := fs.ReadFile(fsys, name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		sum := sha256.Sum256(raw)
		asset := &staticAsset{
			raw:         raw,
			etag:        `"` + hex.EncodeToString(sum[:16]) + `"`,
			contentType: contentTypeFor(name),
		}
		if compressible(name) && len(raw) > 1024 {
			var buf bytes.Buffer
			zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
			if err != nil {
				return err
			}
			if _, err := zw.Write(raw); err != nil {
				return err
			}
			if err := zw.Close(); err != nil {
				return err
			}
			asset.gzip = buf.Bytes()
		}
		bundle.files["/"+strings.TrimPrefix(path.Clean("/"+name), "/")] = asset
		return nil
	})
	if err != nil {
		return nil, err
	}
	// The root URL and the explicit /index.html both serve the shell.
	if index, ok := bundle.files["/index.html"]; ok {
		bundle.files["/"] = index
	}
	return bundle, nil
}

func contentTypeFor(name string) string {
	if strings.HasSuffix(name, ".webmanifest") {
		return "application/manifest+json"
	}
	if ctype := mime.TypeByExtension(path.Ext(name)); ctype != "" {
		return ctype
	}
	return "application/octet-stream"
}

func compressible(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".html", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".webmanifest", ".xml":
		return true
	default:
		return false
	}
}

func (b *staticBundle) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	name := path.Clean("/" + r.URL.Path)
	if strings.HasSuffix(r.URL.Path, "/") {
		name = path.Join(name, "index.html")
	}
	asset, ok := b.files[name]
	if !ok {
		http.NotFound(w, r)
		return
	}

	immutable := r.URL.Query().Get("v") != "" && !strings.HasSuffix(name, ".html")
	if immutable {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("ETag", asset.etag)
	hasGzip := len(asset.gzip) > 0
	if hasGzip {
		w.Header().Add("Vary", "Accept-Encoding")
	}

	if etagMatches(r.Header.Get("If-None-Match"), asset.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	body := asset.raw
	if hasGzip {
		if acceptsGzip(r.Header.Get("Accept-Encoding")) {
			body = asset.gzip
			w.Header().Set("Content-Encoding", "gzip")
		}
	}
	w.Header().Set("Content-Type", asset.contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(body)
}

// devStaticHandler keeps the previous no-cache file server for web_dir
// development, where files change without restarting the process.
func devStaticHandler(fsys fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		if strings.HasSuffix(r.URL.Path, ".webmanifest") {
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		fileServer.ServeHTTP(w, r)
	})
}

func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			continue
		}
		for _, parameter := range fields[1:] {
			if strings.EqualFold(strings.TrimSpace(parameter), "q=0") {
				return false
			}
		}
		return true
	}
	return false
}

func etagMatches(header, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
}
