package ports

import (
	"context"

	contracts "heimdall.dev/contracts/generated/go"
)

type ReviewInput struct {
	ReviewRunID   contracts.ResourceId
	ChangeRequest contracts.ChangeRequest
	Diff          contracts.Diff
}

type ReviewClient interface {
	Review(ctx context.Context, input ReviewInput) ([]contracts.Finding, error)
}
