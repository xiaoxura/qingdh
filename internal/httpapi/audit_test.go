package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

type auditPage struct {
	Entries []struct {
		ID         int64           `json:"id"`
		ActorID    *string         `json:"actorId"`
		ActorEmail string          `json:"actorEmail"`
		TargetID   *string         `json:"targetId"`
		Action     string          `json:"action"`
		Detail     json.RawMessage `json:"detail"`
		CreatedAt  string          `json:"createdAt"`
	} `json:"entries"`
	Total int `json:"total"`
}

func fetchAudit(t *testing.T, c *client, query string) auditPage {
	t.Helper()
	resp := c.do(http.MethodGet, "/api/v1/admin/audit"+query, "")
	if resp.status != http.StatusOK {
		t.Fatalf("audit%s = %d %s", query, resp.status, resp.body)
	}
	var page auditPage
	if err := json.Unmarshal([]byte(resp.body), &page); err != nil {
		t.Fatalf("decode audit: %v (%s)", err, resp.body)
	}
	return page
}

func TestAdminAuditRequiresAdmin(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "audit-normal@example.com", "correct horse battery")

	if resp := c.do(http.MethodGet, "/api/v1/admin/audit", ""); resp.status != http.StatusForbidden {
		t.Fatalf("non-admin audit = %d %s", resp.status, resp.body)
	}
}

func TestAdminAuditFiltersAndPagination(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "audit-admin@example.com", "correct horse battery")
	env.makeAdmin(t, "audit-admin@example.com")

	user := env.client(t)
	registerVerified(t, env, user, "audit-user@example.com", "correct horse battery")

	// 产生三类审计：用户改密、管理员改设置、管理员禁用用户。
	if resp := user.do(http.MethodPost, "/api/v1/auth/password",
		`{"currentPassword":"correct horse battery","newPassword":"another password"}`); resp.status != http.StatusOK {
		t.Fatalf("password change = %d %s", resp.status, resp.body)
	}
	if resp := admin.do(http.MethodPut, "/api/v1/admin/settings", `{"aiDailyLimit":211}`); resp.status != http.StatusOK {
		t.Fatalf("settings = %d %s", resp.status, resp.body)
	}
	users := fetchAdminUsers(t, admin)
	var userID string
	for _, item := range users.Users {
		if item.Email == "audit-user@example.com" {
			userID = item.ID
		}
	}
	if userID == "" {
		t.Fatal("user not found")
	}
	if resp := admin.do(http.MethodPatch, "/api/v1/admin/users/"+userID, `{"disabled":true}`); resp.status != http.StatusOK {
		t.Fatalf("disable = %d %s", resp.status, resp.body)
	}

	all := fetchAudit(t, admin, "?limit=50")
	if all.Total < 3 {
		t.Fatalf("expected at least 3 entries, got %+v", all)
	}
	for _, entry := range all.Entries {
		if entry.ActorEmail == "" {
			t.Fatalf("actor email must be snapshotted: %+v", entry)
		}
		if len(entry.Detail) != 0 && !json.Valid(entry.Detail) {
			t.Fatalf("detail is not JSON: %s", entry.Detail)
		}
	}

	filtered := fetchAudit(t, admin, "?action=admin.settings.update")
	if filtered.Total == 0 {
		t.Fatal("action filter returned nothing")
	}
	for _, entry := range filtered.Entries {
		if entry.Action != "admin.settings.update" {
			t.Fatalf("action filter leaked %q", entry.Action)
		}
	}

	byActor := fetchAudit(t, admin, "?actor="+url.QueryEscape("audit-admin@example.com"))
	if byActor.Total < 2 {
		t.Fatalf("actor filter should include settings + user update: %+v", byActor)
	}
	for _, entry := range byActor.Entries {
		if !strings.Contains(entry.ActorEmail, "audit-admin@example.com") {
			t.Fatalf("actor filter leaked %q", entry.ActorEmail)
		}
	}

	page := fetchAudit(t, admin, "?limit=1&offset=1")
	if len(page.Entries) != 1 || page.Total != all.Total {
		t.Fatalf("pagination = %d entries, total %d (want 1 / %d)", len(page.Entries), page.Total, all.Total)
	}

	empty := fetchAudit(t, admin, "?action=no.such.action")
	if empty.Total != 0 || len(empty.Entries) != 0 {
		t.Fatalf("unknown action should be empty: %+v", empty)
	}
}

func TestAdminAuditKeepsActorEmailAfterDeletion(t *testing.T) {
	env := newEnv(t, nil)
	owner := env.client(t)
	registerVerified(t, env, owner, "audit-owner@example.com", "correct horse battery")
	env.makeAdmin(t, "audit-owner@example.com")

	victimAdmin := env.client(t)
	registerVerified(t, env, victimAdmin, "audit-victim-admin@example.com", "correct horse battery")
	env.makeAdmin(t, "audit-victim-admin@example.com")

	target := env.client(t)
	registerVerified(t, env, target, "audit-target@example.com", "correct horse battery")

	targets := fetchAdminUsers(t, owner)
	var targetID string
	for _, item := range targets.Users {
		if item.Email == "audit-target@example.com" {
			targetID = item.ID
		}
	}
	if resp := victimAdmin.do(http.MethodPatch, "/api/v1/admin/users/"+targetID, `{"disabled":true}`); resp.status != http.StatusOK {
		t.Fatalf("victim admin disable = %d %s", resp.status, resp.body)
	}

	victims := fetchAdminUsers(t, owner)
	var victimID string
	for _, item := range victims.Users {
		if item.Email == "audit-victim-admin@example.com" {
			victimID = item.ID
		}
	}
	if resp := owner.do(http.MethodDelete, "/api/v1/admin/users/"+victimID, ""); resp.status != http.StatusOK {
		t.Fatalf("delete admin = %d %s", resp.status, resp.body)
	}

	page := fetchAudit(t, owner, "?action=admin.user.update&limit=50")
	found := false
	for _, entry := range page.Entries {
		if entry.ActorEmail == "audit-victim-admin@example.com" {
			found = true
			if entry.ActorID != nil {
				t.Fatalf("actor_id should be NULL after deletion: %+v", entry)
			}
		}
	}
	if !found {
		t.Fatalf("actor email did not survive admin deletion: %+v", page)
	}
}

func TestAdminAuditNeverExposesSecrets(t *testing.T) {
	env := newEnv(t, nil)
	admin := env.client(t)
	registerVerified(t, env, admin, "audit-secret-admin@example.com", "correct horse battery")
	env.makeAdmin(t, "audit-secret-admin@example.com")

	owner := env.client(t)
	registerVerified(t, env, owner, "audit-secret-owner@example.com", "correct horse battery")
	marker := testDataKeyEnvelope("memo")
	if resp := owner.do(http.MethodPut, "/api/v1/secrets/memo",
		fmt.Sprintf(`{"baseRevision":0,"payload":%s}`, marker)); resp.status != http.StatusOK {
		t.Fatalf("put memo = %d %s", resp.status, resp.body)
	}

	resp := admin.do(http.MethodGet, "/api/v1/admin/audit?limit=200", "")
	if resp.status != http.StatusOK {
		t.Fatalf("audit = %d %s", resp.status, resp.body)
	}
	for _, forbidden := range []string{testB64(96), "aes-256-gcm", "correct horse battery", "sk-account"} {
		if strings.Contains(resp.body, forbidden) {
			t.Fatalf("audit response leaked %q: %s", forbidden, resp.body)
		}
	}
}

type adminUsersPage struct {
	Users []struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	} `json:"users"`
	Total int `json:"total"`
}

func fetchAdminUsers(t *testing.T, c *client) adminUsersPage {
	t.Helper()
	resp := c.do(http.MethodGet, "/api/v1/admin/users?pageSize=200", "")
	if resp.status != http.StatusOK {
		t.Fatalf("admin users = %d %s", resp.status, resp.body)
	}
	var page adminUsersPage
	if err := json.Unmarshal([]byte(resp.body), &page); err != nil {
		t.Fatalf("decode admin users: %v", err)
	}
	return page
}
