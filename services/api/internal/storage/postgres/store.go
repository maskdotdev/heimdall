package postgres

import (
	"context"
	"errors"

	"heimdall.dev/services/api/internal/ports"

	contracts "heimdall.dev/contracts/generated/go"
)

var ErrNotImplemented = errors.New("postgres review-run store is not implemented yet")

type Store struct{}

func New(_ string) (*Store, error) {
	return nil, ErrNotImplemented
}

func (Store) SaveReviewRunSnapshot(context.Context, ports.ReviewRunSnapshot) error {
	return ErrNotImplemented
}

func (Store) CompleteReviewRun(context.Context, contracts.ReviewRun, []contracts.Finding) error {
	return ErrNotImplemented
}

func (Store) GetReviewRun(context.Context, contracts.ResourceId) (contracts.ReviewRun, error) {
	return contracts.ReviewRun{}, ErrNotImplemented
}

func (Store) ListFindings(context.Context, contracts.ResourceId) ([]contracts.Finding, error) {
	return nil, ErrNotImplemented
}
