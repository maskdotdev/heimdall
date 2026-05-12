package process

import (
	"context"

	"heimdall.dev/services/api/internal/ports"

	contracts "heimdall.dev/contracts/generated/go"
)

type CodeIntelClient struct {
	Runtime WorkerRuntime
}

type codeIntelRequest struct {
	Provider  string `json:"provider"`
	Owner     string `json:"owner"`
	Repo      string `json:"repo"`
	Number    int    `json:"number"`
	URL       string `json:"url"`
	RemoteURL string `json:"remoteUrl,omitempty"`
}

type codeIntelResponse struct {
	Repository    contracts.Repository    `json:"repository"`
	ChangeRequest contracts.ChangeRequest `json:"changeRequest"`
	Diff          contracts.Diff          `json:"diff"`
}

func (client CodeIntelClient) FetchPullRequest(ctx context.Context, ref ports.PullRequestRef) (ports.PullRequestSnapshot, error) {
	var response codeIntelResponse
	if err := client.Runtime.RunModule(ctx, "code_intel.cli", codeIntelRequest{
		Provider:  ref.Provider,
		Owner:     ref.Owner,
		Repo:      ref.Repo,
		Number:    ref.Number,
		URL:       ref.URL,
		RemoteURL: ref.RemoteURL,
	}, &response); err != nil {
		return ports.PullRequestSnapshot{}, err
	}
	return ports.PullRequestSnapshot{
		Repository:    response.Repository,
		ChangeRequest: response.ChangeRequest,
		Diff:          response.Diff,
	}, nil
}
