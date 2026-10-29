package httpapi_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/XiaoXuRa/qingdh/internal/store"
)

func putDocument(t *testing.T, c *client, base int64, payload string) response {
	t.Helper()
	return c.do(http.MethodPut, "/api/v1/workspace",
		fmt.Sprintf(`{"baseRevision":%d,"payload":%s}`, base, payload))
}

func listRevisions(t *testing.T, c *client) ([]revisionInfoDTO, string) {
	t.Helper()
	resp := c.do(http.MethodGet, "/api/v1/workspace/revisions", "")
	if resp.status != http.StatusOK {
		t.Fatalf("list revisions = %d %s", resp.status, resp.body)
	}
	var body struct {
		Revisions []revisionInfoDTO `json:"revisions"`
	}
	if err := json.Unmarshal([]byte(resp.body), &body); err != nil {
		t.Fatalf("decode revisions: %v (%s)", err, resp.body)
	}
	return body.Revisions, resp.body
}

type revisionInfoDTO struct {
	Revision  int64     `json:"revision"`
	Size      int64     `json:"size"`
	CreatedAt time.Time `json:"createdAt"`
}

func TestWorkspaceRevisionsRecordOnlySuccessfulWrites(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "history@example.com", "correct horse battery")

	first := `{"version":2,"groups":[{"id":"g1","name":"一","links":[]}]}`
	second := `{"version":2,"groups":[{"id":"g1","name":"二","links":[]}]}`

	if resp := putDocument(t, c, 0, first); resp.status != http.StatusOK {
		t.Fatalf("first put = %d %s", resp.status, resp.body)
	}
	revisions, _ := listRevisions(t, c)
	if len(revisions) != 1 || revisions[0].Revision != 1 || revisions[0].Size <= 0 || revisions[0].CreatedAt.IsZero() {
		t.Fatalf("unexpected history after first put: %+v", revisions)
	}

	// 409 不得产生历史。
	if resp := putDocument(t, c, 0, second); resp.status != http.StatusConflict {
		t.Fatalf("stale put = %d %s", resp.status, resp.body)
	}
	revisions, _ = listRevisions(t, c)
	if len(revisions) != 1 {
		t.Fatalf("conflict must not create a revision: %+v", revisions)
	}

	if resp := putDocument(t, c, 1, second); resp.status != http.StatusOK {
		t.Fatalf("second put = %d %s", resp.status, resp.body)
	}
	revisions, _ = listRevisions(t, c)
	if len(revisions) != 2 || revisions[0].Revision != 2 || revisions[1].Revision != 1 {
		t.Fatalf("unexpected history: %+v", revisions)
	}

	// 读取历史内容。
	resp := c.do(http.MethodGet, "/api/v1/workspace/revisions/1", "")
	if resp.status != http.StatusOK {
		t.Fatalf("get revision = %d %s", resp.status, resp.body)
	}
	var item struct {
		Revision int64           `json:"revision"`
		Payload  json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal([]byte(resp.body), &item); err != nil {
		t.Fatalf("decode revision: %v", err)
	}
	if item.Revision != 1 || !jsonEqual(item.Payload, []byte(first)) {
		t.Fatalf("unexpected revision payload: %s", resp.body)
	}
	if missing := c.do(http.MethodGet, "/api/v1/workspace/revisions/99", ""); missing.status != http.StatusNotFound {
		t.Fatalf("missing revision = %d %s", missing.status, missing.body)
	}
	if bad := c.do(http.MethodGet, "/api/v1/workspace/revisions/abc", ""); bad.status != http.StatusBadRequest {
		t.Fatalf("invalid revision = %d %s", bad.status, bad.body)
	}

	// 恢复：取历史 payload 后以当前 revision 重新 PUT，revision 继续递增。
	restore := putDocument(t, c, 2, first)
	if restore.status != http.StatusOK {
		t.Fatalf("restore = %d %s", restore.status, restore.body)
	}
	revisions, _ = listRevisions(t, c)
	if len(revisions) != 3 || revisions[0].Revision != 3 {
		t.Fatalf("restore should append revision 3: %+v", revisions)
	}
}

func TestWorkspaceRevisionsAreUserScoped(t *testing.T) {
	env := newEnv(t, nil)
	alice := env.client(t)
	registerVerified(t, env, alice, "history-alice@example.com", "correct horse battery")
	if resp := putDocument(t, alice, 0, `{"version":2,"groups":[{"id":"g1","name":"私密","links":[]}]}`); resp.status != http.StatusOK {
		t.Fatalf("alice put = %d %s", resp.status, resp.body)
	}

	bob := env.client(t)
	registerVerified(t, env, bob, "history-bob@example.com", "correct horse battery")
	revisions, body := listRevisions(t, bob)
	if len(revisions) != 0 {
		t.Fatalf("bob must not see alice's history: %s", body)
	}
	if resp := bob.do(http.MethodGet, "/api/v1/workspace/revisions/1", ""); resp.status != http.StatusNotFound {
		t.Fatalf("cross-user revision = %d %s", resp.status, resp.body)
	}
}

func TestWorkspaceRevisionsKeepEncryptedPayload(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "history-encrypted@example.com", "correct horse battery")

	if resp := putDocument(t, c, 0, testV3Envelope()); resp.status != http.StatusOK {
		t.Fatalf("put encrypted = %d %s", resp.status, resp.body)
	}
	resp := c.do(http.MethodGet, "/api/v1/workspace/revisions/1", "")
	if resp.status != http.StatusOK || !containsVersion(resp.body, 3) {
		t.Fatalf("history should preserve the v3 envelope: %d %s", resp.status, resp.body)
	}
}

func containsVersion(raw string, want int) bool {
	var body struct {
		Payload struct {
			Version int `json:"version"`
		} `json:"payload"`
	}
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		return false
	}
	return body.Payload.Version == want
}

func TestWorkspaceRevisionsRetention(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "history-retention@example.com", "correct horse battery")

	for i := 0; i < 25; i++ {
		payload := fmt.Sprintf(`{"version":2,"groups":[{"id":"g1","name":"v%d","links":[]}]}`, i)
		if resp := putDocument(t, c, int64(i), payload); resp.status != http.StatusOK {
			t.Fatalf("put %d = %d %s", i, resp.status, resp.body)
		}
	}

	user, err := env.store.UserByEmail(t.Context(), "history-retention@example.com")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	removed, err := env.store.PruneDocumentRevisions(t.Context(), 20, 30*24*time.Hour)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if removed != 5 {
		t.Fatalf("pruned %d rows, want 5", removed)
	}
	revisions, err := env.store.ListDocumentRevisions(t.Context(), user.ID, 100)
	if err != nil {
		t.Fatalf("list after prune: %v", err)
	}
	if len(revisions) != 20 || revisions[19].Revision != 6 {
		t.Fatalf("retention should keep revisions 6..25, got %d rows (oldest %d)", len(revisions), revisions[len(revisions)-1].Revision)
	}

	// 超过 30 天的快照即使没被数量策略淘汰也要删除。
	if _, err := env.store.Exec(t.Context(), `
		UPDATE document_revisions SET created_at = now() - interval '31 days'
		WHERE user_id = $1 AND revision = 6`, user.ID); err != nil {
		t.Fatalf("age revision: %v", err)
	}
	if _, err := env.store.PruneDocumentRevisions(t.Context(), 20, 30*24*time.Hour); err != nil {
		t.Fatalf("prune by age: %v", err)
	}
	revisions, err = env.store.ListDocumentRevisions(t.Context(), user.ID, 100)
	if err != nil {
		t.Fatalf("list after age prune: %v", err)
	}
	if len(revisions) != 19 {
		t.Fatalf("aged revision should be removed, got %d rows", len(revisions))
	}
}

func TestWorkspaceRevisionsCascadeOnAccountDelete(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "history-delete@example.com", "correct horse battery")
	if resp := putDocument(t, c, 0, `{"version":2,"groups":[]}`); resp.status != http.StatusOK {
		t.Fatalf("put = %d %s", resp.status, resp.body)
	}
	user, err := env.store.UserByEmail(t.Context(), "history-delete@example.com")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	if resp := c.do(http.MethodDelete, "/api/v1/account", `{"password":"correct horse battery"}`); resp.status != http.StatusOK {
		t.Fatalf("delete account = %d %s", resp.status, resp.body)
	}
	revisions, err := env.store.ListDocumentRevisions(t.Context(), user.ID, 100)
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	if len(revisions) != 0 {
		t.Fatalf("revisions should cascade with the account: %+v", revisions)
	}
}

func TestWorkspaceConcurrentPutsUseSingleRevision(t *testing.T) {
	env := newEnv(t, nil)
	c := env.client(t)
	registerVerified(t, env, c, "history-race@example.com", "correct horse battery")
	user, err := env.store.UserByEmail(t.Context(), "history-race@example.com")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}

	const writers = 8
	results := make(chan error, writers)
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			payload := []byte(fmt.Sprintf(`{"version":2,"groups":[{"id":"g%d","name":"并发","links":[]}]}`, index))
			_, err := env.store.UpdateDocument(t.Context(), user.ID, 0, payload)
			results <- err
		}(i)
	}
	wg.Wait()
	close(results)

	success, conflicts := 0, 0
	for err := range results {
		switch {
		case err == nil:
			success++
		case errors.Is(err, store.ErrConflict):
			conflicts++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if success != 1 || conflicts != writers-1 {
		t.Fatalf("success=%d conflicts=%d, want 1/%d", success, conflicts, writers-1)
	}

	doc, err := env.store.GetDocument(t.Context(), user.ID)
	if err != nil {
		t.Fatalf("load document: %v", err)
	}
	if doc.Revision != 1 {
		t.Fatalf("final revision = %d, want 1", doc.Revision)
	}
	revisions, err := env.store.ListDocumentRevisions(t.Context(), user.ID, 100)
	if err != nil {
		t.Fatalf("list revisions: %v", err)
	}
	if len(revisions) != 1 || revisions[0].Revision != 1 {
		t.Fatalf("concurrent writes must produce exactly one history row: %+v", revisions)
	}
}
