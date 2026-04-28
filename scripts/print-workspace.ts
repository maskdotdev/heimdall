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
    "review-engine",
    "llm-gateway",
    "publisher",
    "memory",
    "observability",
  ],
};

console.log(JSON.stringify(workspace, null, 2));
