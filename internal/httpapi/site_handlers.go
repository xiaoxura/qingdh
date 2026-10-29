package httpapi

import "net/http"

type siteInfoDTO struct {
	Name string `json:"name"`
	Logo string `json:"logo"`
}

// handleSiteInfo exposes only public branding. It never exposes SMTP, session,
// registration or other administrative settings.
func (s *Server) handleSiteInfo(w http.ResponseWriter, _ *http.Request) {
	values := s.settings.Get()
	name := values.SiteName
	if name == "" {
		name = "氢导航"
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, siteInfoDTO{Name: name, Logo: values.SiteLogo})
}
