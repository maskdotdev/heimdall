package local_test

import (
	"context"
	"testing"

	"heimdall.dev/services/api/internal/ports"
	"heimdall.dev/services/api/internal/storage/sqlite"
	"heimdall.dev/services/api/internal/workflow/local"

	contracts "heimdall.dev/contracts/generated/go"
)

type fakeCodeIntel struct{}

func (fakeCodeIntel) FetchPullRequest(context.Context, ports.PullRequestRef) (ports.PullRequestSnapshot, error) {
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
					{Kind: "context", Content: "def review():"},
					{Kind: "added", NewLine: intPointer(2), Content: "    return 'ok'"},
				},
			}},
		}},
	}
	return ports.PullRequestSnapshot{Repository: repository, ChangeRequest: changeRequest, Diff: diff}, nil
}

type fakeReview struct {
	received ports.ReviewInput
}

func (review *fakeReview) Review(_ context.Context, input ports.ReviewInput) ([]contracts.Finding, error) {
	review.received = input
	return []contracts.Finding{
		{
			SchemaVersion: "1.0.0",
			Id:            "finding_1",
			ReviewRunId:   input.ReviewRunID,
			Title:         "Finding",
			Body:          "Body",
			Category:      "maintainability",
			Severity:      "low",
			Confidence:    "high",
			Evidence:      []contracts.FindingEvidence{{Kind: "diff-line", Summary: "Evidence"}},
			Status:        "validated",
			Validation:    contracts.FindingValidation{SchemaValid: true, LocationValid: true, EvidenceValid: true, RedactionValid: true},
		},
	}, nil
}

func TestWorkflowRunsReviewAndPersistsState(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	review := &fakeReview{}
	workflow := local.NewWorkflow(store, fakeCodeIntel{}, review)
	reviewRun, err := workflow.StartReviewRunFromURL(ctx, ports.ReviewRunFromURLCommand{
		URL: "https://github.com/acme/heimdall/pull/42",
		PullRequest: ports.PullRequestRef{
			Provider: "github",
			Owner:    "acme",
			Repo:     "heimdall",
			Number:   42,
			URL:      "https://github.com/acme/heimdall/pull/42",
		},
	})
	if err != nil {
		t.Fatalf("start review run: %v", err)
	}

	if reviewRun.State != "completed" || reviewRun.FindingsSummary.Total != 1 {
		t.Fatalf("unexpected review run: %#v", reviewRun)
	}
	if review.received.ReviewRunID != reviewRun.Id {
		t.Fatalf("review received wrong input: %#v", review.received)
	}
	if review.received.Diff.Id != "diff_1" || review.received.ChangeRequest.Id != "cr_1" {
		t.Fatalf("review received wrong change input: %#v", review.received)
	}

	findings, err := store.ListFindings(ctx, reviewRun.Id)
	if err != nil {
		t.Fatalf("list findings: %v", err)
	}
	if len(findings) != 1 || findings[0].ReviewRunId != reviewRun.Id {
		t.Fatalf("unexpected findings: %#v", findings)
	}
}

func intPointer(value int) *int {
	return &value
}
