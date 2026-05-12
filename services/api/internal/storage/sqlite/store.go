package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"heimdall.dev/services/api/internal/ports"

	contracts "heimdall.dev/contracts/generated/go"

	_ "github.com/mattn/go-sqlite3"
)

const schema = `
CREATE TABLE IF NOT EXISTS contract_blobs (
	kind TEXT NOT NULL,
	id TEXT NOT NULL,
	review_run_id TEXT,
	payload TEXT NOT NULL,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS contract_blobs_review_run_idx
ON contract_blobs (kind, review_run_id);
`

type Store struct {
	db *sql.DB
}

func Open(ctx context.Context, path string) (*Store, error) {
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite store: %w", err)
	}

	if _, err := db.ExecContext(ctx, schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("initialize sqlite store: %w", err)
	}

	return &Store{db: db}, nil
}

func (store *Store) Close() error {
	return store.db.Close()
}

func (store *Store) SaveReviewRunSnapshot(ctx context.Context, snapshot ports.ReviewRunSnapshot) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin review run snapshot transaction: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if err = saveBlobTx(ctx, tx, "repository", string(snapshot.Repository.Id), "", snapshot.Repository); err != nil {
		return err
	}
	if err = saveBlobTx(ctx, tx, "change-request", string(snapshot.ChangeRequest.Id), "", snapshot.ChangeRequest); err != nil {
		return err
	}
	if err = saveBlobTx(ctx, tx, "diff", string(snapshot.Diff.Id), "", snapshot.Diff); err != nil {
		return err
	}
	if err = saveBlobTx(ctx, tx, "review-run", string(snapshot.ReviewRun.Id), string(snapshot.ReviewRun.Id), snapshot.ReviewRun); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit review run snapshot transaction: %w", err)
	}
	return nil
}

func (store *Store) CompleteReviewRun(ctx context.Context, reviewRun contracts.ReviewRun, findings []contracts.Finding) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin complete review run transaction: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	reviewRunID := reviewRun.Id
	if _, err = tx.ExecContext(ctx, `DELETE FROM contract_blobs WHERE kind = 'finding' AND review_run_id = ?`, string(reviewRunID)); err != nil {
		return fmt.Errorf("replace findings: %w", err)
	}

	for _, finding := range findings {
		if finding.ReviewRunId != reviewRunID {
			return fmt.Errorf("finding %s belongs to review run %s, expected %s", finding.Id, finding.ReviewRunId, reviewRunID)
		}
		if err = saveBlobTx(ctx, tx, "finding", string(finding.Id), string(reviewRunID), finding); err != nil {
			return err
		}
	}
	if err = saveBlobTx(ctx, tx, "review-run", string(reviewRun.Id), string(reviewRun.Id), reviewRun); err != nil {
		return err
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit complete review run transaction: %w", err)
	}
	return nil
}

func (store *Store) GetReviewRun(ctx context.Context, reviewRunID contracts.ResourceId) (contracts.ReviewRun, error) {
	var reviewRun contracts.ReviewRun
	if err := store.getBlob(ctx, "review-run", string(reviewRunID), &reviewRun); err != nil {
		return contracts.ReviewRun{}, err
	}
	return reviewRun, nil
}

func (store *Store) ListFindings(ctx context.Context, reviewRunID contracts.ResourceId) ([]contracts.Finding, error) {
	rows, err := store.db.QueryContext(
		ctx,
		`SELECT payload FROM contract_blobs WHERE kind = 'finding' AND review_run_id = ? ORDER BY id`,
		string(reviewRunID),
	)
	if err != nil {
		return nil, fmt.Errorf("list findings: %w", err)
	}
	defer rows.Close()

	findings := []contracts.Finding{}
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			return nil, fmt.Errorf("scan finding: %w", err)
		}

		var finding contracts.Finding
		if err := json.Unmarshal([]byte(payload), &finding); err != nil {
			return nil, fmt.Errorf("decode finding: %w", err)
		}
		findings = append(findings, finding)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate findings: %w", err)
	}
	return findings, nil
}

func (store *Store) getBlob(ctx context.Context, kind string, id string, value any) error {
	var payload string
	if err := store.db.QueryRowContext(ctx, `SELECT payload FROM contract_blobs WHERE kind = ? AND id = ?`, kind, id).Scan(&payload); err != nil {
		return fmt.Errorf("get %s %s: %w", kind, id, err)
	}

	if err := json.Unmarshal([]byte(payload), value); err != nil {
		return fmt.Errorf("decode %s %s: %w", kind, id, err)
	}
	return nil
}

type blobExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func saveBlobTx(ctx context.Context, executor blobExecutor, kind string, id string, reviewRunID string, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode %s %s: %w", kind, id, err)
	}

	if _, err := executor.ExecContext(
		ctx,
		`INSERT INTO contract_blobs (kind, id, review_run_id, payload)
		VALUES (?, ?, NULLIF(?, ''), ?)
		ON CONFLICT(kind, id) DO UPDATE SET
			review_run_id = excluded.review_run_id,
			payload = excluded.payload,
			updated_at = CURRENT_TIMESTAMP`,
		kind,
		id,
		reviewRunID,
		string(payload),
	); err != nil {
		return fmt.Errorf("save %s %s: %w", kind, id, err)
	}
	return nil
}
