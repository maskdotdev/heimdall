package fake

import (
	"context"

	"heimdall.dev/services/api/internal/ports"

	contracts "heimdall.dev/contracts/generated/go"
)

type ReviewClient struct{}

func (ReviewClient) Review(_ context.Context, input ports.ReviewInput) ([]contracts.Finding, error) {
	return []contracts.Finding{
		{
			SchemaVersion: "1.0.0",
			Id:            contracts.ResourceId("finding_" + string(input.ReviewRunID) + "_1"),
			ReviewRunId:   input.ReviewRunID,
			Source:        stringPointer("llm"),
			Title:         "Fixture-backed review finding",
			Body:          "The local fake reviewer produced this deterministic finding through the API workflow path.",
			Category:      "maintainability",
			Severity:      "low",
			Confidence:    "high",
			Evidence: []contracts.FindingEvidence{
				{Kind: "diff-line", Summary: "The diff context included a changed line."},
			},
			Status: "validated",
			Validation: contracts.FindingValidation{
				SchemaValid:    true,
				LocationValid:  true,
				EvidenceValid:  true,
				RedactionValid: true,
			},
		},
	}, nil
}
