package settings

import (
	"strings"
	"testing"
	"time"
)

func TestDefaultValues(t *testing.T) {
	v := Default()
	if !v.AllowRegistration || !v.RequireEmailVerification {
		t.Fatalf("unexpected defaults: %+v", v)
	}
	idle, absolute, renew := v.Durations()
	if idle != 14*24*time.Hour || absolute != 180*24*time.Hour || renew != time.Hour {
		t.Fatalf("durations = %s %s %s", idle, absolute, renew)
	}
	if v.VerificationRequired() {
		t.Fatal("verification cannot be effective without SMTP")
	}
}

func TestEffectiveVerificationNeedsSMTP(t *testing.T) {
	v := Default()
	v.SMTPHost = "smtp.example.com"
	v.SMTPFrom = "noreply@example.com"
	if !v.VerificationRequired() {
		t.Fatal("verification should be effective with SMTP")
	}
	if !v.SMTPConfigured() {
		t.Fatal("smtp should be configured")
	}
	v.SMTPPort = 587
	if cfg := v.SMTPConfig(); cfg.Host != "smtp.example.com" || cfg.Port != 587 {
		t.Fatalf("smtp config = %+v", cfg)
	}
}

func TestValidateBaseURL(t *testing.T) {
	v := Default()
	v.BaseURL = " https://nav.example.com/ "
	if err := v.Validate(); err != nil {
		t.Fatalf("valid base url rejected: %v", err)
	}
	if v.BaseURL != "https://nav.example.com" {
		t.Fatalf("base url not normalized: %q", v.BaseURL)
	}

	for _, bad := range []string{"nav.example.com", "ftp://example.com", "https://example.com/app", "https://example.com/?q=1"} {
		v := Default()
		v.BaseURL = bad
		if err := v.Validate(); err == nil {
			t.Fatalf("expected %q to be rejected", bad)
		}
	}

	empty := Default()
	if err := empty.Validate(); err != nil {
		t.Fatalf("empty base url should be allowed: %v", err)
	}
	if empty.BaseURLValue() != nil {
		t.Fatal("empty base url should return nil")
	}
}

func TestValidate(t *testing.T) {
	valid := func() Values {
		v := Default()
		v.SMTPHost = "smtp.example.com"
		v.SMTPFrom = "noreply@example.com"
		return v
	}

	if err := func() error { v := valid(); return v.Validate() }(); err != nil {
		t.Fatalf("valid settings rejected: %v", err)
	}

	cases := []struct {
		name string
		edit func(*Values)
	}{
		{"bad port", func(v *Values) { v.SMTPPort = 70000 }},
		{"bad from", func(v *Values) { v.SMTPFrom = "nope" }},
		{"missing from", func(v *Values) { v.SMTPFrom = "" }},
		{"bad tls", func(v *Values) { v.SMTPTLS = "ssl" }},
		{"idle too short", func(v *Values) { v.SessionIdleSeconds = 60 }},
		{"absolute below idle", func(v *Values) { v.SessionAbsoluteSeconds = 3600 }},
		{"renew too short", func(v *Values) { v.SessionRenewSeconds = 10 }},
		{"renew above idle", func(v *Values) {
			v.SessionRenewSeconds = v.SessionIdleSeconds + 1
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := valid()
			tc.edit(&v)
			if err := v.Validate(); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestValidateNormalizes(t *testing.T) {
	v := Default()
	v.SMTPHost = "  smtp.example.com  "
	v.SMTPFrom = " noreply@example.com "
	v.SMTPTLS = " STARTTLS "
	if err := v.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if v.SMTPHost != "smtp.example.com" || v.SMTPTLS != "starttls" {
		t.Fatalf("not normalized: %+v", v)
	}
}

func TestValidateMessagesAreReadable(t *testing.T) {
	v := Default()
	v.SMTPHost = "smtp.example.com"
	v.SMTPFrom = "noreply@example.com"
	v.SMTPPort = 0
	err := v.Validate()
	if err == nil || !strings.Contains(err.Error(), "端口") {
		t.Fatalf("unexpected error: %v", err)
	}
}
