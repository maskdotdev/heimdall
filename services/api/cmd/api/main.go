package main

import (
	"context"
	"log"
	"net/http"
	"os"

	"heimdall.dev/services/api/internal/adapters/fake"
	"heimdall.dev/services/api/internal/adapters/process"
	"heimdall.dev/services/api/internal/ports"
	"heimdall.dev/services/api/internal/storage/sqlite"
	"heimdall.dev/services/api/internal/transport/httpapi"
	"heimdall.dev/services/api/internal/workflow/local"
)

func main() {
	ctx := context.Background()
	sqlitePath := os.Getenv("HEIMDALL_SQLITE_PATH")
	if sqlitePath == "" {
		sqlitePath = ".heimdall/dev.db"
	}

	store, err := sqlite.Open(ctx, sqlitePath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer store.Close()

	codeIntelClient, reviewClient := workerClients()
	workflow := local.NewWorkflow(store, codeIntelClient, reviewClient)
	server := httpapi.NewServer(store, workflow)
	addr := os.Getenv("HEIMDALL_API_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}

	log.Printf("heimdall api listening on http://%s", addr)
	if err := http.ListenAndServe(addr, server.Handler()); err != nil {
		log.Fatalf("serve api: %v", err)
	}
}

func workerClients() (ports.CodeIntelClient, ports.ReviewClient) {
	if os.Getenv("HEIMDALL_WORKER_MODE") != "process" {
		return fake.CodeIntelClient{}, fake.ReviewClient{}
	}

	repoRoot := os.Getenv("HEIMDALL_REPO_ROOT")
	if repoRoot == "" {
		repoRoot = "../.."
	}
	runtime := process.WorkerRuntime{RepoRoot: repoRoot}
	return process.CodeIntelClient{Runtime: runtime}, process.ReviewClient{Runtime: runtime}
}
