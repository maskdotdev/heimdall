package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"heimdall.dev/services/api/internal/ports"
	"heimdall.dev/services/api/internal/transport/httpapi"

	contracts "heimdall.dev/contracts/generated/go"
)

type fakeStore struct {
	reviewRun contracts.ReviewRun
	findings  []contracts.Finding
}

func (fakeStore) SaveReviewRunSnapshot(context.Context, ports.ReviewRunSnapshot) error {
	return nil
}
func (fakeStore) CompleteReviewRun(context.Context, contracts.ReviewRun, []contracts.Finding) error {
	return nil
}
func (store fakeStore) GetReviewRun(context.Context, contracts.ResourceId) (contracts.ReviewRun, error) {
	return store.reviewRun, nil
}
func (store fakeStore) ListFindings(context.Context, contracts.ResourceId) ([]contracts.Finding, error) {
	return store.findings, nil
}

type fakeWorkflow struct {
	command ports.ReviewRunFromURLCommand
}

func (workflow *fakeWorkflow) StartReviewRunFromURL(_ context.Context, command ports.ReviewRunFromURLCommand) (contracts.ReviewRun, error) {
	workflow.command = command
	return contracts.ReviewRun{
		SchemaVersion:   "1.0.0",
		Id:              "run_1",
		ChangeRequestId: "cr_1",
		RepositoryId:    "repo_1",
		State:           "queued",
		CreatedAt:       "2026-05-11T12:00:00Z",
	}, nil
}

func TestCreateReviewRunFromURL(t *testing.T) {
	workflow := &fakeWorkflow{}
	server := httpapi.NewServer(fakeStore{}, workflow)
	body := []byte(`{"url":"https://github.com/acme/heimdall/pull/42"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/review-runs/from-url", bytes.NewReader(body))
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	if workflow.command.PullRequest.Owner != "acme" || workflow.command.PullRequest.Number != 42 {
		t.Fatalf("unexpected workflow command: %#v", workflow.command)
	}
}

func TestCreateReviewRunFromURLRejectsInvalidURL(t *testing.T) {
	server := httpapi.NewServer(fakeStore{}, &fakeWorkflow{})
	body := []byte(`{"url":"https://github.com/acme/heimdall/issues/42"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/review-runs/from-url", bytes.NewReader(body))
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d", response.Code)
	}
}

func TestGetReviewRunFindings(t *testing.T) {
	server := httpapi.NewServer(fakeStore{
		findings: []contracts.Finding{{Id: "finding_1"}},
	}, &fakeWorkflow{})
	request := httptest.NewRequest(http.MethodGet, "/api/review-runs/run_1/findings", nil)
	response := httptest.NewRecorder()

	server.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.Code)
	}

	var body struct {
		Findings []contracts.Finding `json:"findings"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Findings) != 1 || body.Findings[0].Id != "finding_1" {
		t.Fatalf("unexpected findings response: %#v", body)
	}
}
