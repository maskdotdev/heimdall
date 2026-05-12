package process_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"heimdall.dev/services/api/internal/adapters/process"
	"heimdall.dev/services/api/internal/ports"

	contracts "heimdall.dev/contracts/generated/go"
)

func TestCodeIntelClientInvokesPythonWorker(t *testing.T) {
	ctx := context.Background()
	remote := createRemoteWithPullRef(t)
	client := process.CodeIntelClient{Runtime: process.WorkerRuntime{RepoRoot: repoRoot(t)}}

	snapshot, err := client.FetchPullRequest(ctx, ports.PullRequestRef{
		Provider:  "github",
		Owner:     "acme",
		Repo:      "heimdall",
		Number:    42,
		URL:       "https://github.com/acme/heimdall/pull/42",
		RemoteURL: remote,
	})
	if err != nil {
		t.Fatalf("fetch pull request: %v", err)
	}
	if snapshot.Diff.Summary.FileCount != 1 || snapshot.Diff.Files[0].Path != "review.py" {
		t.Fatalf("unexpected snapshot: %#v", snapshot)
	}
}

func TestReviewClientInvokesPythonWorker(t *testing.T) {
	ctx := context.Background()
	client := process.ReviewClient{Runtime: process.WorkerRuntime{RepoRoot: repoRoot(t), Env: []string{"HEIMDALL_REVIEW_PROVIDER=fake"}}}
	changeRequest := contracts.ChangeRequest{
		SchemaVersion:           "1.0.0",
		Id:                      "cr_1",
		Repository:              contracts.Repository{SchemaVersion: "1.0.0", Id: "repo_1", Provider: "github", Owner: "acme", Name: "heimdall", DefaultBranch: "main"},
		Provider:                "github",
		ProviderChangeRequestId: "42",
		Title:                   "PR",
		State:                   "open",
		Base:                    contracts.ChangeRef{Ref: "main", Sha: "aaaaaaaa"},
		Head:                    contracts.ChangeRef{Ref: "pull/42/head", Sha: "bbbbbbbb"},
	}
	diff := contracts.Diff{
		SchemaVersion:   "1.0.0",
		Id:              "diff_1",
		ChangeRequestId: "cr_1",
		BaseSha:         "aaaaaaaa",
		HeadSha:         "bbbbbbbb",
		Summary:         contracts.DiffSummary{FileCount: 1, Additions: 1, Deletions: 0},
		Files: []contracts.ChangedFile{{
			Path:      "review.py",
			Status:    "modified",
			Additions: 1,
			Deletions: 0,
			Hunks: []contracts.DiffHunk{{
				OldStart: 1,
				OldLines: 1,
				NewStart: 1,
				NewLines: 2,
				Lines: []contracts.DiffLine{
					{Kind: "context", OldLine: intPointer(1), NewLine: intPointer(1), Content: "print(\"old\")"},
					{Kind: "added", NewLine: intPointer(2), Content: "print(\"new\")"},
				},
			}},
		}},
	}

	findings, err := client.Review(ctx, ports.ReviewInput{
		ReviewRunID:   "run_1",
		ChangeRequest: changeRequest,
		Diff:          diff,
	})
	if err != nil {
		t.Fatalf("review change: %v", err)
	}
	if len(findings) != 1 || findings[0].ReviewRunId != "run_1" {
		t.Fatalf("unexpected findings: %#v", findings)
	}
}

func intPointer(value int) *int {
	return &value
}

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../../../../")
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	return root
}

func createRemoteWithPullRef(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	remote := filepath.Join(root, "remote.git")
	run(t, "git", "init", worktree)
	run(t, "git", "-C", worktree, "config", "user.email", "dev@example.com")
	run(t, "git", "-C", worktree, "config", "user.name", "Dev")
	if err := os.WriteFile(filepath.Join(worktree, "review.py"), []byte("print(\"old\")\n"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	run(t, "git", "-C", worktree, "add", "review.py")
	run(t, "git", "-C", worktree, "commit", "-m", "base")
	run(t, "git", "-C", worktree, "branch", "-M", "main")
	base := run(t, "git", "-C", worktree, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(worktree, "review.py"), []byte("print(\"old\")\nprint(\"new\")\n"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	run(t, "git", "-C", worktree, "commit", "-am", "pr")
	head := run(t, "git", "-C", worktree, "rev-parse", "HEAD")
	run(t, "git", "init", "--bare", remote)
	run(t, "git", "-C", worktree, "remote", "add", "origin", remote)
	run(t, "git", "-C", worktree, "push", "origin", base+":refs/heads/main")
	run(t, "git", "-C", worktree, "push", "origin", head+":refs/pull/42/head")
	run(t, "git", "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main")
	return remote
}

func run(t *testing.T, name string, args ...string) string {
	t.Helper()
	command := exec.Command(name, args...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s failed: %v\n%s", name, err, string(output))
	}
	return string(bytesTrimSpace(output))
}

func bytesTrimSpace(value []byte) []byte {
	for len(value) > 0 && (value[len(value)-1] == '\n' || value[len(value)-1] == '\r' || value[len(value)-1] == ' ') {
		value = value[:len(value)-1]
	}
	return value
}
