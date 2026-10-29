package httpapi_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestChangePasswordValidation(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "change@example.com", "correct horse battery")

	cases := []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{
			name:   "wrong current password",
			body:   `{"currentPassword":"wrong password","newPassword":"another password"}`,
			status: http.StatusForbidden,
			code:   "invalid_password",
		},
		{
			name:   "short new password",
			body:   `{"currentPassword":"correct horse battery","newPassword":"short"}`,
			status: http.StatusUnprocessableEntity,
			code:   "weak_password",
		},
		{
			name:   "same as old password",
			body:   `{"currentPassword":"correct horse battery","newPassword":"correct horse battery"}`,
			status: http.StatusUnprocessableEntity,
			code:   "same_password",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := c.do(http.MethodPost, "/api/v1/auth/password", tc.body)
			if resp.status != tc.status || !strings.Contains(resp.body, tc.code) {
				t.Fatalf("status = %d, body = %s", resp.status, resp.body)
			}
		})
	}

	unauth := env.client(t)
	if resp := unauth.do(http.MethodPost, "/api/v1/auth/password",
		`{"currentPassword":"x","newPassword":"another password"}`); resp.status != http.StatusUnauthorized {
		t.Fatalf("anonymous change = %d %s", resp.status, resp.body)
	}
}

func TestChangePasswordKeepsCurrentSessionAndRevokesOthers(t *testing.T) {
	env := newEnv(t, nil)
	current := env.client(t)
	registerVerified(t, env, current, "rotate@example.com", "correct horse battery")

	other := env.client(t)
	if resp := other.login("rotate@example.com", "correct horse battery"); resp.status != http.StatusOK {
		t.Fatalf("second login = %d %s", resp.status, resp.body)
	}
	if resp := other.do(http.MethodGet, "/api/v1/auth/me", ""); resp.status != http.StatusOK {
		t.Fatalf("other device before change = %d %s", resp.status, resp.body)
	}

	before := len(env.mailer.messages)
	resp := current.do(http.MethodPost, "/api/v1/auth/password",
		`{"currentPassword":"correct horse battery","newPassword":"brand new password"}`)
	if resp.status != http.StatusOK {
		t.Fatalf("change password = %d %s", resp.status, resp.body)
	}

	// 当前会话保留，其他设备退出。
	if me := current.do(http.MethodGet, "/api/v1/auth/me", ""); me.status != http.StatusOK {
		t.Fatalf("current session = %d %s", me.status, me.body)
	}
	if me := other.do(http.MethodGet, "/api/v1/auth/me", ""); me.status != http.StatusUnauthorized {
		t.Fatalf("other session = %d %s", me.status, me.body)
	}

	// 旧密码失效，新密码可用。
	if old := env.client(t).login("rotate@example.com", "correct horse battery"); old.status != http.StatusUnauthorized {
		t.Fatalf("old password = %d %s", old.status, old.body)
	}
	if fresh := env.client(t).login("rotate@example.com", "brand new password"); fresh.status != http.StatusOK {
		t.Fatalf("new password = %d %s", fresh.status, fresh.body)
	}

	// 审计与通知邮件。
	entries, err := env.store.ListAudit(context.Background(), nil, 20)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	found := false
	for _, entry := range entries {
		if entry.Action == "account.password_change" {
			found = true
		}
	}
	if !found {
		t.Fatalf("password change was not audited: %+v", entries)
	}
	if len(env.mailer.messages) != before+1 || !strings.Contains(env.mailer.last().Subject, "密码已修改") {
		t.Fatalf("expected a password changed email, got %+v", env.mailer.messages[before:])
	}
}

func TestChangePasswordRateLimitedPerUser(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "password-limit@example.com", "correct horse battery")

	statuses := make([]int, 0, 4)
	for i := 0; i < 4; i++ {
		resp := c.do(http.MethodPost, "/api/v1/auth/password",
			fmt.Sprintf(`{"currentPassword":"wrong-%d","newPassword":"another password"}`, i))
		statuses = append(statuses, resp.status)
	}
	want := []int{http.StatusForbidden, http.StatusForbidden, http.StatusForbidden, http.StatusTooManyRequests}
	for i := range want {
		if statuses[i] != want[i] {
			t.Fatalf("attempt %d = %d, want %d (all: %v)", i+1, statuses[i], want[i], statuses)
		}
	}
}
