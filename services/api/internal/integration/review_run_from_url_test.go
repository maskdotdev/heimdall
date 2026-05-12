package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"heimdall.dev/services/api/internal/adapters/fake"
	"heimdall.dev/services/api/internal/storage/sqlite"
	"heimdall.dev/services/api/internal/transport/httpapi"
	"heimdall.dev/services/api/internal/workflow/local"

	contracts "heimdall.dev/contracts/generated/go"
)

func TestReviewRunFromURLCompletesThroughLocalWorkflow(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(ctx, ":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	workflow := local.NewWorkflow(store, fake.CodeIntelClient{}, fake.ReviewClient{})
	server := httpapi.NewServer(store, workflow)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/review-runs/from-url",
		bytes.NewReader([]byte(`{"url":"https://github.com/acme/heimdall/pull/42"}`)),
	)
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("unexpected status: %d", response.Code)
	}

	var reviewRun contracts.ReviewRun
	if err := json.NewDecoder(response.Body).Decode(&reviewRun); err != nil {
		t.Fatalf("decode review run: %v", err)
	}
	if reviewRun.State != "completed" {
		t.Fatalf("unexpected review run state: %s", reviewRun.State)
	}

	findingsRequest := httptest.NewRequest(http.MethodGet, "/api/review-runs/"+string(reviewRun.Id)+"/findings", nil)
	findingsResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(findingsResponse, findingsRequest)

	if findingsResponse.Code != http.StatusOK {
		t.Fatalf("unexpected findings status: %d", findingsResponse.Code)
	}

	var body struct {
		Findings []contracts.Finding `json:"findings"`
	}
	if err := json.NewDecoder(findingsResponse.Body).Decode(&body); err != nil {
		t.Fatalf("decode findings: %v", err)
	}
	if len(body.Findings) != 1 || body.Findings[0].ReviewRunId != reviewRun.Id {
		t.Fatalf("unexpected findings response: %#v", body)
	}
}
