package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	githubvcs "heimdall.dev/services/api/internal/adapters/vcs/github"
	"heimdall.dev/services/api/internal/ports"

	contracts "heimdall.dev/contracts/generated/go"
)

type Server struct {
	store    ports.ReviewRunStore
	workflow ports.ReviewWorkflow
}

func NewServer(store ports.ReviewRunStore, workflow ports.ReviewWorkflow) *Server {
	return &Server{store: store, workflow: workflow}
}

func (server *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/review-runs/from-url", server.handleCreateReviewRunFromURL)
	mux.HandleFunc("/api/review-runs/", server.handleReviewRuns)
	return mux
}

type createReviewRunFromURLRequest struct {
	URL string `json:"url"`
}

type findingsResponse struct {
	Findings []contracts.Finding `json:"findings"`
}

type errorResponse struct {
	Error string `json:"error"`
}

func (server *Server) handleCreateReviewRunFromURL(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeError(response, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var body createReviewRunFromURLRequest
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		writeError(response, http.StatusBadRequest, "request body must be valid JSON")
		return
	}

	ref, err := githubvcs.ParsePullRequestURL(body.URL)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}

	reviewRun, err := server.workflow.StartReviewRunFromURL(request.Context(), ports.ReviewRunFromURLCommand{
		URL:         body.URL,
		PullRequest: ref,
	})
	if err != nil {
		writeError(response, http.StatusInternalServerError, "failed to start review run")
		return
	}

	writeJSON(response, http.StatusAccepted, reviewRun)
}

func (server *Server) handleReviewRuns(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(response, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	suffix := strings.TrimPrefix(request.URL.Path, "/api/review-runs/")
	if suffix == "" {
		writeError(response, http.StatusNotFound, "review run not found")
		return
	}

	if strings.HasSuffix(suffix, "/findings") {
		reviewRunID := strings.TrimSuffix(suffix, "/findings")
		server.handleReviewRunFindings(response, request, contracts.ResourceId(reviewRunID))
		return
	}

	reviewRun, err := server.store.GetReviewRun(request.Context(), contracts.ResourceId(suffix))
	if err != nil {
		writeError(response, http.StatusNotFound, "review run not found")
		return
	}

	writeJSON(response, http.StatusOK, reviewRun)
}

func (server *Server) handleReviewRunFindings(response http.ResponseWriter, request *http.Request, reviewRunID contracts.ResourceId) {
	findings, err := server.store.ListFindings(request.Context(), reviewRunID)
	if err != nil {
		writeError(response, http.StatusNotFound, "review run findings not found")
		return
	}

	writeJSON(response, http.StatusOK, findingsResponse{Findings: findings})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("content-type", "application/json")
	response.WriteHeader(status)
	if err := json.NewEncoder(response).Encode(value); err != nil && !errors.Is(err, http.ErrHandlerTimeout) {
		http.Error(response, "failed to write response", http.StatusInternalServerError)
	}
}

func writeError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, errorResponse{Error: message})
}
