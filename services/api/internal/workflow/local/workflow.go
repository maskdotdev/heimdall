package local

import (
	"context"
	"fmt"
	"strings"
	"time"

	"heimdall.dev/services/api/internal/ports"

	contracts "heimdall.dev/contracts/generated/go"
)

type Workflow struct {
	store     ports.ReviewRunStore
	codeIntel ports.CodeIntelClient
	review    ports.ReviewClient
	now       func() time.Time
}

func NewWorkflow(store ports.ReviewRunStore, codeIntel ports.CodeIntelClient, review ports.ReviewClient) *Workflow {
	return &Workflow{
		store:     store,
		codeIntel: codeIntel,
		review:    review,
		now:       func() time.Time { return time.Now().UTC() },
	}
}

func (workflow *Workflow) StartReviewRunFromURL(ctx context.Context, command ports.ReviewRunFromURLCommand) (contracts.ReviewRun, error) {
	snapshot, err := workflow.codeIntel.FetchPullRequest(ctx, command.PullRequest)
	if err != nil {
		return contracts.ReviewRun{}, fmt.Errorf("fetch pull request: %w", err)
	}

	reviewRunID := contracts.ResourceId(resourceID("run", command.PullRequest.Provider, command.PullRequest.Owner, command.PullRequest.Repo, fmt.Sprint(command.PullRequest.Number)))
	now := contracts.Timestamp(workflow.now().Format(time.RFC3339))
	reviewRun := contracts.ReviewRun{
		SchemaVersion:   "1.0.0",
		Id:              reviewRunID,
		ChangeRequestId: snapshot.ChangeRequest.Id,
		RepositoryId:    snapshot.Repository.Id,
		State:           "running",
		Phase:           stringPointer("review"),
		Trigger:         stringPointer("api"),
		CreatedAt:       now,
		StartedAt:       &now,
		UpdatedAt:       &now,
	}

	if err := workflow.store.SaveReviewRunSnapshot(ctx, ports.ReviewRunSnapshot{
		Repository:    snapshot.Repository,
		ChangeRequest: snapshot.ChangeRequest,
		Diff:          snapshot.Diff,
		ReviewRun:     reviewRun,
	}); err != nil {
		return contracts.ReviewRun{}, fmt.Errorf("save review run snapshot: %w", err)
	}

	findings, err := workflow.review.Review(ctx, ports.ReviewInput{
		ReviewRunID:   reviewRunID,
		ChangeRequest: snapshot.ChangeRequest,
		Diff:          snapshot.Diff,
	})
	if err != nil {
		return contracts.ReviewRun{}, fmt.Errorf("review change: %w", err)
	}
	completedAt := contracts.Timestamp(workflow.now().Format(time.RFC3339))
	reviewRun.State = "completed"
	reviewRun.Phase = stringPointer("done")
	reviewRun.CompletedAt = &completedAt
	reviewRun.UpdatedAt = &completedAt
	reviewRun.FindingsSummary = &contracts.FindingsSummary{Total: len(findings)}
	if err := workflow.store.CompleteReviewRun(ctx, reviewRun, findings); err != nil {
		return contracts.ReviewRun{}, fmt.Errorf("complete review run: %w", err)
	}
	return reviewRun, nil
}

func resourceID(prefix string, parts ...string) string {
	value := strings.Join(append([]string{prefix}, parts...), "_")
	replacer := strings.NewReplacer("/", "_", " ", "_", "#", "_")
	return replacer.Replace(value)
}

func stringPointer(value string) *string {
	return &value
}
