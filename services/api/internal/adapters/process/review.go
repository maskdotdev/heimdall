package process

import (
	"context"

	"heimdall.dev/services/api/internal/ports"

	contracts "heimdall.dev/contracts/generated/go"
)

type ReviewClient struct {
	Runtime WorkerRuntime
}

type reviewRequest struct {
	ReviewRunID   contracts.ResourceId    `json:"reviewRunId"`
	ChangeRequest contracts.ChangeRequest `json:"changeRequest"`
	Diff          contracts.Diff          `json:"diff"`
}

type reviewResponse struct {
	Findings []contracts.Finding `json:"findings"`
}

func (client ReviewClient) Review(ctx context.Context, input ports.ReviewInput) ([]contracts.Finding, error) {
	var response reviewResponse
	if err := client.Runtime.RunModule(ctx, "review_worker.cli", reviewRequest{
		ReviewRunID:   input.ReviewRunID,
		ChangeRequest: input.ChangeRequest,
		Diff:          input.Diff,
	}, &response); err != nil {
		return nil, err
	}
	return response.Findings, nil
}
