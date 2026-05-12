package ports

import (
	"context"

	contracts "heimdall.dev/contracts/generated/go"
)

type PullRequestRef struct {
	Provider string
	Owner    string
	Repo     string
	Number   int
	URL      string
	RemoteURL string
}

type PullRequestSnapshot struct {
	Repository    contracts.Repository
	ChangeRequest contracts.ChangeRequest
	Diff          contracts.Diff
}

type CodeIntelClient interface {
	FetchPullRequest(ctx context.Context, ref PullRequestRef) (PullRequestSnapshot, error)
}
