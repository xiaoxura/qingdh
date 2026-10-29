package auth

import (
	"errors"
	"net/mail"
	"strings"
)

// NormalizeEmail trims and lowercases an address and validates its syntax.
func NormalizeEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if email == "" {
		return "", errors.New("请输入邮箱")
	}
	if len(email) > 254 {
		return "", errors.New("邮箱地址过长")
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email || addr.Name != "" {
		return "", errors.New("邮箱格式不正确")
	}
	// Require a dot in the domain: transactional mail to bare hosts never works.
	at := strings.LastIndex(email, "@")
	if at < 0 || !strings.Contains(email[at+1:], ".") {
		return "", errors.New("邮箱格式不正确")
	}
	return email, nil
}
