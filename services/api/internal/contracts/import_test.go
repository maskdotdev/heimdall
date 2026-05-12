package contracts_test

import (
	"testing"

	contracts "heimdall.dev/contracts/generated/go"
)

func TestGeneratedContractsImport(t *testing.T) {
	reviewRun := contracts.ReviewRun{
		SchemaVersion:   "1.0.0",
		Id:              "run_test",
		ChangeRequestId: "cr_test",
		RepositoryId:    "repo_test",
		State:           "queued",
		CreatedAt:       "2026-05-11T12:00:00Z",
	}

	if reviewRun.Id != "run_test" {
		t.Fatalf("unexpected review run id: %s", reviewRun.Id)
	}
}
