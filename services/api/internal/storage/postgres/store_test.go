package postgres_test

import (
	"testing"

	"heimdall.dev/services/api/internal/ports"
	"heimdall.dev/services/api/internal/storage/postgres"
)

func TestStoreUsesReviewRunStorePort(t *testing.T) {
	var _ ports.ReviewRunStore = postgres.Store{}
}
