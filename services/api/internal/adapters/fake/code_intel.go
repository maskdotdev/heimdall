package fake

import (
	"context"
	"fmt"

	"heimdall.dev/services/api/internal/ports"

	contracts "heimdall.dev/contracts/generated/go"
)

type CodeIntelClient struct{}

func (CodeIntelClient) FetchPullRequest(_ context.Context, ref ports.PullRequestRef) (ports.PullRequestSnapshot, error) {
	repositoryID := contracts.ResourceId(fmt.Sprintf("repo_%s_%s_%s", ref.Provider, ref.Owner, ref.Repo))
	changeRequestID := contracts.ResourceId(fmt.Sprintf("cr_%s_%s_%s_%d", ref.Provider, ref.Owner, ref.Repo, ref.Number))
	repository := contracts.Repository{
		SchemaVersion: "1.0.0",
		Id:            repositoryID,
		Provider:      contracts.Provider(ref.Provider),
		Owner:         ref.Owner,
		Name:          ref.Repo,
		FullName:      stringPointer(fmt.Sprintf("%s/%s", ref.Owner, ref.Repo)),
		DefaultBranch: "main",
		WebUrl:        uriPointer(fmt.Sprintf("https://github.com/%s/%s", ref.Owner, ref.Repo)),
	}
	changeRequest := contracts.ChangeRequest{
		SchemaVersion:           "1.0.0",
		Id:                      changeRequestID,
		Repository:              repository,
		Provider:                contracts.Provider(ref.Provider),
		ProviderChangeRequestId: contracts.ProviderObjectId(fmt.Sprint(ref.Number)),
		Number:                  &ref.Number,
		Title:                   fmt.Sprintf("GitHub PR #%d", ref.Number),
		State:                   "open",
		Base:                    contracts.ChangeRef{RepositoryId: &repositoryID, Ref: "main", Sha: "aaaaaaaa"},
		Head:                    contracts.ChangeRef{RepositoryId: &repositoryID, Ref: contracts.RefName(fmt.Sprintf("pull/%d/head", ref.Number)), Sha: "bbbbbbbb"},
		WebUrl:                  uriPointer(ref.URL),
	}
	diff := contracts.Diff{
		SchemaVersion:   "1.0.0",
		Id:              contracts.ResourceId(fmt.Sprintf("diff_%s_%s_%s_%d", ref.Provider, ref.Owner, ref.Repo, ref.Number)),
		ChangeRequestId: changeRequestID,
		BaseSha:         "aaaaaaaa",
		HeadSha:         "bbbbbbbb",
		Summary:         contracts.DiffSummary{FileCount: 1, Additions: 1, Deletions: 0, Languages: []string{"Python"}},
		Files: []contracts.ChangedFile{
			{
				Path:      "review.py",
				Status:    "modified",
				Language:  stringPointer("Python"),
				Additions: 1,
				Deletions: 0,
				Hunks: []contracts.DiffHunk{
					{
						OldStart: 1,
						OldLines: 1,
						NewStart: 1,
						NewLines: 2,
						Lines: []contracts.DiffLine{
							{Kind: "context", OldLine: intPointer(1), NewLine: intPointer(1), Content: "print(\"old\")"},
							{Kind: "added", NewLine: intPointer(2), Content: "print(\"new\")"},
						},
					},
				},
			},
		},
	}
	return ports.PullRequestSnapshot{Repository: repository, ChangeRequest: changeRequest, Diff: diff}, nil
}
