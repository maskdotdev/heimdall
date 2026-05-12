package ports

import (
	"context"

	contracts "heimdall.dev/contracts/generated/go"
)

type ReviewRunFromURLCommand struct {
	URL         string
	PullRequest PullRequestRef
}

type ReviewWorkflow interface {
	StartReviewRunFromURL(ctx context.Context, command ReviewRunFromURLCommand) (contracts.ReviewRun, error)
}
