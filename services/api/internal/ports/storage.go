package ports

import (
	"context"

	contracts "heimdall.dev/contracts/generated/go"
)

type ReviewRunSnapshot struct {
	Repository    contracts.Repository
	ChangeRequest contracts.ChangeRequest
	Diff          contracts.Diff
	ReviewRun     contracts.ReviewRun
}

type ReviewRunStore interface {
	SaveReviewRunSnapshot(ctx context.Context, snapshot ReviewRunSnapshot) error
	CompleteReviewRun(ctx context.Context, reviewRun contracts.ReviewRun, findings []contracts.Finding) error
	GetReviewRun(ctx context.Context, reviewRunID contracts.ResourceId) (contracts.ReviewRun, error)
	ListFindings(ctx context.Context, reviewRunID contracts.ResourceId) ([]contracts.Finding, error)
}
