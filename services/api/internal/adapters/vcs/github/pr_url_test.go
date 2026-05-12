package github_test

import (
	"testing"

	"heimdall.dev/services/api/internal/adapters/vcs/github"
)

func TestParsePullRequestURL(t *testing.T) {
	ref, err := github.ParsePullRequestURL("https://github.com/acme/heimdall/pull/42")
	if err != nil {
		t.Fatalf("parse pull request url: %v", err)
	}

	if ref.Provider != "github" || ref.Owner != "acme" || ref.Repo != "heimdall" || ref.Number != 42 {
		t.Fatalf("unexpected ref: %#v", ref)
	}
}

func TestParsePullRequestURLRejectsUnsupportedURLs(t *testing.T) {
	for _, rawURL := range []string{
		"http://github.com/acme/heimdall/pull/42",
		"https://gitlab.com/acme/heimdall/-/merge_requests/42",
		"https://github.com/acme/heimdall/issues/42",
		"https://github.com/acme/heimdall/pull/0",
	} {
		if _, err := github.ParsePullRequestURL(rawURL); err == nil {
			t.Fatalf("expected %s to be rejected", rawURL)
		}
	}
}
