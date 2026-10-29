package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/XiaoXuRa/qingdh/internal/store"
)

type userDTO struct {
	ID            string    `json:"id"`
	Email         string    `json:"email"`
	EmailVerified bool      `json:"emailVerified"`
	PendingEmail  string    `json:"pendingEmail,omitempty"`
	IsAdmin       bool      `json:"isAdmin"`
	Disabled      bool      `json:"disabled"`
	CreatedAt     time.Time `json:"createdAt"`

	// EmailChangeAvailable 是运行期能力，不是账号属性；前端据此禁用入口。
	EmailChangeAvailable bool `json:"emailChangeAvailable"`
}

type adminUserDTO struct {
	userDTO
	CloudItems   int `json:"cloudItems"`
	CloudLinks   int `json:"cloudLinks"`
	CloudGroups  int `json:"cloudGroups"`
	CloudSecrets int `json:"cloudSecrets"`
}

func toAdminUserDTO(u store.AdminUser) adminUserDTO {
	return adminUserDTO{
		userDTO:      toUserDTO(u.User),
		CloudItems:   u.CloudLinks + u.CloudGroups + u.CloudSecrets,
		CloudLinks:   u.CloudLinks,
		CloudGroups:  u.CloudGroups,
		CloudSecrets: u.CloudSecrets,
	}
}

func toUserDTO(u store.User) userDTO {
	dto := userDTO{
		ID:            u.ID.String(),
		Email:         u.Email,
		EmailVerified: u.Verified(),
		IsAdmin:       u.IsAdmin,
		Disabled:      u.DisabledAt != nil,
		CreatedAt:     u.CreatedAt,
	}
	if u.PendingEmail != nil {
		dto.PendingEmail = *u.PendingEmail
	}
	return dto
}

// authUserDTO adds runtime capabilities for the signed-in account UI.
func (s *Server) authUserDTO(u store.User) userDTO {
	dto := toUserDTO(u)
	dto.EmailChangeAvailable = s.settings.Get().SMTPConfigured()
	return dto
}

type sessionDTO struct {
	ID            string    `json:"id"`
	ExpiresAt     time.Time `json:"expiresAt"`
	LastRenewedAt time.Time `json:"lastRenewedAt"`
	LastSeenAt    time.Time `json:"lastSeenAt"`
	CreatedAt     time.Time `json:"createdAt"`
	UserAgent     string    `json:"userAgent,omitempty"`
	IP            string    `json:"ip,omitempty"`
	Current       bool      `json:"current,omitempty"`
}

func toSessionDTO(s store.Session) sessionDTO {
	return sessionDTO{
		ID:            s.ID.String(),
		ExpiresAt:     s.ExpiresAt,
		LastRenewedAt: s.LastRenewedAt,
		LastSeenAt:    s.LastSeenAt,
		CreatedAt:     s.CreatedAt,
	}
}

type workspaceDTO struct {
	Revision  int64           `json:"revision"`
	Payload   json.RawMessage `json:"payload"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

func clientIPFrom(r *http.Request) string {
	ip, _ := r.Context().Value(ctxKeyClientIP).(string)
	return ip
}

func contextWithTimeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}

func parseUUID(raw string) (uuid.UUID, bool) {
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}
