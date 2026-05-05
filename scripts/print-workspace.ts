const workspace = {
  apps: ["api", "web", "worker", "indexer-cli"],
  packages: [
    "contracts",
    "config",
    "db",
    "github",
    "queue",
    "repo-sync",
    "index-schema",
    "indexer-driver",
    "indexer-ts",
    "index-importer",
    "embedding",
    "retrieval",
    "review-orchestrator",
    "review-engine",
    "llm-gateway",
    "publisher",
    "artifacts",
    "evaluation",
    "memory",
    "observability",
    "security",
    "admin-tools",
  ],
};

console.log(JSON.stringify(workspace, null, 2));
