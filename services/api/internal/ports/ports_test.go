package ports_test

import (
	"context"
	"testing"

	"heimdall.dev/services/api/internal/ports"

	contracts "heimdall.dev/contracts/generated/go"
)

type fakeStore struct{}

func (fakeStore) SaveReviewRunSnapshot(context.Context, ports.ReviewRunSnapshot) error {
	return nil
}
func (fakeStore) CompleteReviewRun(context.Context, contracts.ReviewRun, []contracts.Finding) error {
	return nil
}
func (fakeStore) GetReviewRun(context.Context, contracts.ResourceId) (contracts.ReviewRun, error) {
	return contracts.ReviewRun{}, nil
}
func (fakeStore) ListFindings(context.Context, contracts.ResourceId) ([]contracts.Finding, error) {
	return nil, nil
}

type fakeWorkflow struct{}

func (fakeWorkflow) StartReviewRunFromURL(context.Context, ports.ReviewRunFromURLCommand) (contracts.ReviewRun, error) {
	return contracts.ReviewRun{}, nil
}

type fakeCodeIntel struct{}

func (fakeCodeIntel) FetchPullRequest(context.Context, ports.PullRequestRef) (ports.PullRequestSnapshot, error) {
	return ports.PullRequestSnapshot{}, nil
}

type fakeReview struct{}

func (fakeReview) Review(context.Context, ports.ReviewInput) ([]contracts.Finding, error) {
	return nil, nil
}

func TestPortContracts(t *testing.T) {
	var _ ports.ReviewRunStore = fakeStore{}
	var _ ports.ReviewWorkflow = fakeWorkflow{}
	var _ ports.CodeIntelClient = fakeCodeIntel{}
	var _ ports.ReviewClient = fakeReview{}
}
