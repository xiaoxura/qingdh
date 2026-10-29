package auth

import (
	"strings"
	"testing"
)

func TestHashPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$") {
		t.Fatalf("unexpected format: %s", hash)
	}

	ok, err := VerifyPassword("correct horse battery staple", hash)
	if err != nil || !ok {
		t.Fatalf("verify correct password: ok=%v err=%v", ok, err)
	}

	ok, err = VerifyPassword("wrong password", hash)
	if err != nil {
		t.Fatalf("verify wrong password: %v", err)
	}
	if ok {
		t.Fatal("wrong password must not verify")
	}
}

func TestHashPasswordUsesUniqueSalts(t *testing.T) {
	a, _ := HashPassword("same password")
	b, _ := HashPassword("same password")
	if a == b {
		t.Fatal("two hashes of the same password must differ")
	}
}

func TestVerifyPasswordInvalidHash(t *testing.T) {
	for _, encoded := range []string{"", "plaintext", "$2a$10$abc", "$argon2id$v=19$m=x,t=2,p=1$aa$bb"} {
		if _, err := VerifyPassword("whatever", encoded); err == nil {
			t.Fatalf("expected an error for %q", encoded)
		}
	}
}

func TestValidatePassword(t *testing.T) {
	if err := ValidatePassword("1234567"); err == nil {
		t.Fatal("7 characters must be rejected")
	}
	if err := ValidatePassword("12345678"); err != nil {
		t.Fatalf("8 characters must pass: %v", err)
	}
	if err := ValidatePassword(strings.Repeat("a", 129)); err == nil {
		t.Fatal("129 characters must be rejected")
	}
}

func TestNormalizeEmail(t *testing.T) {
	got, err := NormalizeEmail("  User@Example.COM ")
	if err != nil || got != "user@example.com" {
		t.Fatalf("got %q, %v", got, err)
	}

	bad := []string{"", "nope", "a@b", "a@@b.com", "Name <a@b.com>", "a b@c.com", "a@.com"}
	for _, input := range bad {
		if _, err := NormalizeEmail(input); err == nil {
			t.Fatalf("expected %q to be rejected", input)
		}
	}
}

func TestTokenRoundTrip(t *testing.T) {
	raw, hash, err := NewToken()
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	if len(raw) < 40 {
		t.Fatalf("token too short: %d", len(raw))
	}
	if string(hash) == raw {
		t.Fatal("stored hash must not equal the raw token")
	}
	if string(hash) != string(HashToken(raw)) {
		t.Fatal("hash mismatch")
	}
	if string(hash) == string(HashToken(raw+"x")) {
		t.Fatal("different tokens must hash differently")
	}
}
