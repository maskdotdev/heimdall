package sqlite_test

import (
	"context"
	"path/filepath"
	"testing"

	"heimdall.dev/services/api/internal/ports"
	"heimdall.dev/services/api/internal/storage/sqlite"

	contracts "heimdall.dev/contracts/generated/go"
)

func TestStorePersistsReviewRunsAndFindings(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "heimdall.db"))
	if err != nil {
		t.Fatalf("open sqlite store: %v", err)
	}
	defer store.Close()

	var _ ports.ReviewRunStore = store

	reviewRun := contracts.ReviewRun{
		SchemaVersion:   "1.0.0",
		Id:              "run_1",
		ChangeRequestId: "cr_1",
		RepositoryId:    "repo_1",
		State:           "running",
		CreatedAt:       "2026-05-11T12:00:00Z",
	}
	repository := contracts.Repository{
		SchemaVersion: "1.0.0",
		Id:            "repo_1",
		Provider:      "github",
		Owner:         "acme",
		Name:          "heimdall",
		DefaultBranch: "main",
	}
	changeRequest := contracts.ChangeRequest{
		SchemaVersion:           "1.0.0",
		Id:                      "cr_1",
		Repository:              repository,
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
		Summary:         contracts.DiffSummary{FileCount: 0, Additions: 0, Deletions: 0},
		Files:           []contracts.ChangedFile{},
	}
	if err := store.SaveReviewRunSnapshot(ctx, ports.ReviewRunSnapshot{
		Repository:    repository,
		ChangeRequest: changeRequest,
		Diff:          diff,
		ReviewRun:     reviewRun,
	}); err != nil {
		t.Fatalf("save review run snapshot: %v", err)
	}

	finding := contracts.Finding{
		SchemaVersion: "1.0.0",
		Id:            "finding_1",
		ReviewRunId:   "run_1",
		Title:         "Finding",
		Body:          "A validated finding.",
		Category:      "correctness",
		Severity:      "medium",
		Confidence:    "high",
		Evidence: []contracts.FindingEvidence{
			{Kind: "diff-line", Summary: "Evidence"},
		},
		Status: "validated",
		Validation: contracts.FindingValidation{
			SchemaValid:    true,
			LocationValid:  true,
			EvidenceValid:  true,
			RedactionValid: true,
		},
	}
	reviewRun.State = "completed"
	if err := store.CompleteReviewRun(ctx, reviewRun, []contracts.Finding{finding}); err != nil {
		t.Fatalf("complete review run: %v", err)
	}

	storedRun, err := store.GetReviewRun(ctx, "run_1")
	if err != nil {
		t.Fatalf("get review run: %v", err)
	}
	if storedRun.Id != "run_1" {
		t.Fatalf("unexpected stored review run id: %s", storedRun.Id)
	}

	findings, err := store.ListFindings(ctx, "run_1")
	if err != nil {
		t.Fatalf("list findings: %v", err)
	}
	if len(findings) != 1 || findings[0].Id != "finding_1" {
		t.Fatalf("unexpected findings: %#v", findings)
	}
}
