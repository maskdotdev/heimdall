package github

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"heimdall.dev/services/api/internal/ports"
)

func ParsePullRequestURL(rawURL string) (ports.PullRequestRef, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ports.PullRequestRef{}, fmt.Errorf("parse pull request url: %w", err)
	}

	if parsed.Scheme != "https" || strings.ToLower(parsed.Host) != "github.com" {
		return ports.PullRequestRef{}, fmt.Errorf("unsupported pull request provider")
	}

	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 4 || parts[2] != "pull" {
		return ports.PullRequestRef{}, fmt.Errorf("url must be a GitHub pull request URL")
	}

	number, err := strconv.Atoi(parts[3])
	if err != nil || number < 1 {
		return ports.PullRequestRef{}, fmt.Errorf("pull request number must be positive")
	}

	return ports.PullRequestRef{
		Provider: "github",
		Owner:    parts[0],
		Repo:     parts[1],
		Number:   number,
		URL:      rawURL,
	}, nil
}
