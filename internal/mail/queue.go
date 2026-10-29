package mail

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Queue decouples HTTP handlers from SMTP round trips. Registration and
// password reset enqueue a message and return immediately; a small worker pool
// retries transient failures in the background. SendNow remains available for
// the admin "send test email" action, where the operator expects a synchronous
// result.
type Queue struct {
	next    Mailer
	logger  *slog.Logger
	ctx     context.Context
	workers int

	mu     sync.Mutex
	closed bool
	jobs   chan queuedMessage
	wg     sync.WaitGroup
}

type queuedMessage struct {
	msg      Message
	attempts int
}

// NewQueue builds a queue. workers is clamped to at least one.
func NewQueue(next Mailer, logger *slog.Logger, workers int) *Queue {
	if workers <= 0 {
		workers = 2
	}
	return &Queue{
		next:    next,
		logger:  logger,
		workers: workers,
		jobs:    make(chan queuedMessage, 256),
	}
}

// Start launches workers. The context controls retry waits; the queue is
// drained by Close when the process shuts down.
func (q *Queue) Start(ctx context.Context) {
	q.ctx = ctx
	for i := 0; i < q.workers; i++ {
		q.wg.Add(1)
		go q.worker()
	}
}

// Send satisfies Mailer by enqueueing a message. It never blocks on SMTP, but
// returns an error when the bounded queue is full or the queue is closed.
func (q *Queue) Send(ctx context.Context, msg Message) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return context.Canceled
	}
	select {
	case q.jobs <- queuedMessage{msg: msg}:
		return nil
	default:
		q.logger.Warn("mail queue full; dropping message", "to", msg.To, "subject", msg.Subject)
		return context.DeadlineExceeded
	}
}

// SendNow waits for the SMTP result. Used by the test-email endpoint.
func (q *Queue) SendNow(ctx context.Context, msg Message) error {
	return q.next.Send(ctx, msg)
}

// Close stops accepting messages, drains the queue, and waits for workers.
func (q *Queue) Close() {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	q.closed = true
	close(q.jobs)
	q.mu.Unlock()
	q.wg.Wait()
}

func (q *Queue) worker() {
	defer q.wg.Done()
	ctx := q.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	for job := range q.jobs {
		err := q.next.Send(ctx, job.msg)
		if err == nil {
			continue
		}
		if job.attempts >= 3 {
			q.logger.Error("mail delivery failed permanently", "error", err, "to", job.msg.To, "subject", job.msg.Subject)
			continue
		}
		backoff := time.Duration(1<<job.attempts) * time.Second
		if job.attempts == 2 {
			backoff = 15 * time.Second
		}
		q.logger.Warn("mail delivery failed; retrying", "error", err, "to", job.msg.To, "attempt", job.attempts+1)
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			job.attempts++
			q.mu.Lock()
			if !q.closed {
				select {
				case q.jobs <- job:
				default:
					q.logger.Warn("mail queue full while retrying", "to", job.msg.To)
				}
			}
			q.mu.Unlock()
		}
	}
}

// compile-time check that Queue can replace a Mailer in the HTTP layer.
var _ Mailer = (*Queue)(nil)
