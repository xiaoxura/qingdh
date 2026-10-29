// Package auth implements password hashing, token generation and session
// lifecycle helpers shared by the HTTP layer and the CLI.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters. These follow the OWASP minimum recommendation
// (19 MiB, 2 iterations, 1 thread) and are stored inside each hash, so they
// can be raised later without breaking existing passwords.
const (
	argonMemory      = 19 * 1024
	argonIterations  = 2
	argonParallelism = 1
	argonSaltLength  = 16
	argonKeyLength   = 32
)

// ErrInvalidHash is returned when a stored hash cannot be parsed.
var ErrInvalidHash = errors.New("auth: invalid password hash")

// ErrPasswordBusy 表示 Argon2 并发槽位已满。每次哈希约占 19 MiB，不能无限
// 排队，否则少量并发登录就能把进程内存打满；调用方应返回 503/429。
var ErrPasswordBusy = errors.New("auth: password hashing busy")

// maxConcurrentHashes 限制单实例同时进行的 Argon2 计算数量。
const maxConcurrentHashes = 4

var hashSlots = make(chan struct{}, maxConcurrentHashes)

// acquireHashSlot 非阻塞地占用一个哈希槽；返回 false 表示应直接拒绝请求。
func acquireHashSlot() bool {
	select {
	case hashSlots <- struct{}{}:
		return true
	default:
		return false
	}
}

func releaseHashSlot() { <-hashSlots }

// HashPassword derives an Argon2id hash encoded in the standard PHC format.
func HashPassword(password string) (string, error) {
	if !acquireHashSlot() {
		return "", ErrPasswordBusy
	}
	defer releaseHashSlot()

	salt := make([]byte, argonSaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonIterations, argonMemory, argonParallelism, argonKeyLength)

	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonIterations, argonParallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// VerifyPassword checks a password against a PHC-formatted Argon2id hash in
// constant time.
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrInvalidHash
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false, ErrInvalidHash
	}
	if version != argon2.Version {
		return false, fmt.Errorf("%w: unsupported version %d", ErrInvalidHash, version)
	}

	var memory uint32
	var iterations uint32
	var parallelism uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil {
		return false, ErrInvalidHash
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, ErrInvalidHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, ErrInvalidHash
	}

	if !acquireHashSlot() {
		return false, ErrPasswordBusy
	}
	defer releaseHashSlot()

	got := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// ValidatePassword enforces the project's password policy: 8 to 128 bytes.
func ValidatePassword(password string) error {
	if len(password) < 8 {
		return errors.New("密码至少需要 8 个字符")
	}
	if len(password) > 128 {
		return errors.New("密码不能超过 128 个字符")
	}
	return nil
}

// NewToken returns a URL-safe random token and its SHA-256 hash. Only the hash
// is stored server-side.
func NewToken() (raw string, hash []byte, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", nil, fmt.Errorf("generate token: %w", err)
	}
	raw = base64.RawURLEncoding.EncodeToString(buf)
	return raw, HashToken(raw), nil
}

// HashToken hashes a raw token for database lookup.
func HashToken(raw string) []byte {
	sum := sha256.Sum256([]byte(raw))
	return sum[:]
}

// NewRequestID returns a short random identifier for logs.
func NewRequestID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(randFallback(), 36)
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

var fallbackCounter int64

func randFallback() int64 {
	fallbackCounter++
	return fallbackCounter
}
