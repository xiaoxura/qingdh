package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
)

type siteInfoDTO struct {
	Name string `json:"name"`
	Logo string `json:"logo"`
}

// handleSiteInfo exposes only public branding. It never exposes SMTP, session,
// registration or other administrative settings.
func (s *Server) handleSiteInfo(w http.ResponseWriter, r *http.Request) {
	values := s.settings.Get()
	name := values.SiteName
	if name == "" {
		name = "氢导航"
	}
	etag := fmt.Sprintf(`"site-%d"`, values.Version)
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "public, max-age=0, must-revalidate")
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(siteInfoDTO{Name: name, Logo: values.SiteLogo})
}
