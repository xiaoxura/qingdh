package mail

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

type flakyMailer struct {
	attempts atomic.Int32
	failures int32
}

func (f *flakyMailer) Send(context.Context, Message) error {
	attempt := f.attempts.Add(1)
	if attempt <= f.failures {
		return errors.New("temporary smtp failure")
	}
	return nil
}

func TestQueueRetriesAndDrains(t *testing.T) {
	mailer := &flakyMailer{failures: 1}
	queue := NewQueue(mailer, slog.New(slog.NewTextHandler(io.Discard, nil)), 1)
	queue.Start(context.Background())

	if err := queue.Send(context.Background(), Message{To: "a@example.com", Subject: "hi"}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for mailer.attempts.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	queue.Close()
	if got := mailer.attempts.Load(); got < 2 {
		t.Fatalf("attempts = %d, want at least 2", got)
	}
}

func TestQueueStopAcceptsNoNewMessages(t *testing.T) {
	queue := NewQueue(&flakyMailer{}, slog.New(slog.NewTextHandler(io.Discard, nil)), 1)
	queue.Start(context.Background())
	queue.Close()
	if err := queue.Send(context.Background(), Message{To: "a@example.com"}); err == nil {
		t.Fatal("Send after Close should fail")
	}
}

func TestQueueSendNowIsSynchronous(t *testing.T) {
	mailer := &flakyMailer{}
	queue := NewQueue(mailer, slog.New(slog.NewTextHandler(io.Discard, nil)), 1)
	if err := queue.SendNow(context.Background(), Message{To: "a@example.com"}); err != nil {
		t.Fatalf("SendNow: %v", err)
	}
	if mailer.attempts.Load() != 1 {
		t.Fatalf("attempts = %d", mailer.attempts.Load())
	}
}
