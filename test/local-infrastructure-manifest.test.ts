import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Local compose file path. */
const COMPOSE_FILE = resolve("compose.yaml");

/** Local infrastructure documentation path. */
const INFRA_README_FILE = resolve("infra/README.md");

/** Local Prometheus configuration path. */
const PROMETHEUS_CONFIG_FILE = resolve("infra/observability/prometheus.yaml");

/** Local Prometheus alert rules path. */
const PROMETHEUS_RULES_FILE = resolve("infra/observability/prometheus-rules.yaml");

/** Local Grafana datasource provisioning path. */
const GRAFANA_DATASOURCES_FILE = resolve(
  "infra/observability/grafana/provisioning/datasources/datasources.yaml",
);

/** Local Grafana dashboard provider provisioning path. */
const GRAFANA_DASHBOARD_PROVIDER_FILE = resolve(
  "infra/observability/grafana/provisioning/dashboards/dashboards.yaml",
);

/** Local Grafana dashboard JSON directory. */
const GRAFANA_DASHBOARD_JSON_DIR = resolve(
  "infra/observability/grafana/provisioning/dashboards/json",
);

/** Review artifact environment variables required for local object storage. */
const REVIEW_ARTIFACT_ENV = [
  "HEIMDALL_REVIEW_ARTIFACT_BUCKET",
  "HEIMDALL_REVIEW_ARTIFACT_ENDPOINT",
  "HEIMDALL_REVIEW_ARTIFACT_REGION",
  "HEIMDALL_REVIEW_ARTIFACT_ACCESS_KEY_ID",
  "HEIMDALL_REVIEW_ARTIFACT_SECRET_ACCESS_KEY",
  "HEIMDALL_REVIEW_ARTIFACT_FORCE_PATH_STYLE",
];

/** Starter dashboards expected in the local Grafana provisioning bundle. */
const EXPECTED_GRAFANA_DASHBOARDS = [
  {
    file: "api-overview.json",
    metric: "code_review_agent_api_requests_total",
    title: "Heimdall API Overview",
  },
  {
    file: "queue-overview.json",
    metric: "code_review_agent_queue_jobs_started_total",
    title: "Heimdall Queue Overview",
  },
  {
    file: "review-pipeline.json",
    metric: "code_review_agent_review_stages_total",
    title: "Heimdall Review Pipeline",
  },
  {
    file: "llm-retrieval.json",
    metric: "code_review_agent_llm_calls_total",
    title: "Heimdall LLM and Retrieval",
  },
  {
    file: "indexing-embedding.json",
    metric: "code_review_agent_indexer_driver_runs_total",
    title: "Heimdall Indexing and Embedding",
  },
  {
    file: "publishing.json",
    metric: "code_review_agent_publisher_runs_total",
    title: "Heimdall Publishing",
  },
  {
    file: "webhook-github.json",
    metric: "code_review_agent_webhook_deliveries_total",
    title: "Heimdall Webhook and GitHub",
  },
] as const;

/** Starter Prometheus alerts expected in the local observability bundle. */
const EXPECTED_PROMETHEUS_ALERTS = [
  {
    alert: "HeimdallApiHighErrorRate",
    metric: "code_review_agent_api_requests_total",
    runbook: "docs/runbooks/observability-alerts.md#api-down",
  },
  {
    alert: "HeimdallWebhookIngestionFailures",
    metric: "code_review_agent_webhook_rejections_total",
    runbook: "docs/runbooks/observability-alerts.md#webhook-ingestion-failures",
  },
  {
    alert: "HeimdallReviewQueueRetrySpike",
    metric: "code_review_agent_queue_retries_total",
    runbook: "docs/runbooks/observability-alerts.md#review-queue-backlog",
  },
  {
    alert: "HeimdallEmbeddingBacklog",
    metric: "code_review_agent_queue_oldest_job_age_ms",
    runbook: "docs/runbooks/observability-alerts.md#embedding-backlog",
  },
  {
    alert: "HeimdallReviewFailureRate",
    metric: "code_review_agent_review_stages_total",
    runbook: "docs/runbooks/observability-alerts.md#review-failure-rate",
  },
  {
    alert: "HeimdallPublishingFailureRate",
    metric: "code_review_agent_publisher_runs_total",
    runbook: "docs/runbooks/observability-alerts.md#publishing-failure-rate",
  },
  {
    alert: "HeimdallLlmProviderOutage",
    metric: "code_review_agent_llm_calls_total",
    runbook: "docs/runbooks/observability-alerts.md#llm-provider-outage",
  },
  {
    alert: "HeimdallCostAnomaly",
    metric: "code_review_agent_llm_estimated_cost_micros_total",
    runbook: "docs/runbooks/observability-alerts.md#cost-anomaly",
  },
  {
    alert: "HeimdallIndexingFailures",
    metric: "code_review_agent_indexer_driver_runs_total",
    runbook: "docs/runbooks/observability-alerts.md#indexing-failures",
  },
  {
    alert: "HeimdallSandboxViolationSpike",
    metric: "code_review_agent_sandbox_violations_total",
    runbook: "docs/runbooks/observability-alerts.md#sandbox-violation-spike",
  },
] as const;

describe("local infrastructure manifest", () => {
  it("starts object storage alongside Postgres and Redis", () => {
    const compose = readFileSync(COMPOSE_FILE, "utf8");

    expect(compose).toContain("postgres:");
    expect(compose).toContain("redis:");
    expect(compose).toContain("object-storage:");
    expect(compose).toContain("image: minio/minio:latest");
    expect(compose).toContain('"9000:9000"');
    expect(compose).toContain('"9001:9001"');
    expect(compose).toContain("object-storage-init:");
    expect(compose).toContain("heimdall-review-artifacts");
    expect(compose).toContain("object_storage_data:");
  });

  it("documents local review artifact object-storage settings", () => {
    const readme = readFileSync(INFRA_README_FILE, "utf8");

    for (const envName of REVIEW_ARTIFACT_ENV) {
      expect(readme).toContain(envName);
    }
    expect(readme).toContain("http://localhost:9000");
    expect(readme).toContain("heimdall-review-artifacts");
  });

  it("provisions local Grafana datasources and starter dashboards", () => {
    const compose = readFileSync(COMPOSE_FILE, "utf8");
    const datasources = readFileSync(GRAFANA_DATASOURCES_FILE, "utf8");
    const dashboardProvider = readFileSync(GRAFANA_DASHBOARD_PROVIDER_FILE, "utf8");
    const dashboardFiles = new Set(readdirSync(GRAFANA_DASHBOARD_JSON_DIR));

    expect(compose).toContain(
      "./infra/observability/grafana/provisioning:/etc/grafana/provisioning:ro",
    );
    expect(datasources).toContain("uid: prometheus");
    expect(datasources).toContain("uid: tempo");
    expect(dashboardProvider).toContain("path: /etc/grafana/provisioning/dashboards/json");

    for (const dashboard of EXPECTED_GRAFANA_DASHBOARDS) {
      expect(dashboardFiles.has(dashboard.file)).toBe(true);

      const dashboardJson = JSON.parse(
        readFileSync(resolve(GRAFANA_DASHBOARD_JSON_DIR, dashboard.file), "utf8"),
      ) as unknown;

      expect(dashboardJson).toMatchObject({ title: dashboard.title });
      expect(JSON.stringify(dashboardJson)).toContain(dashboard.metric);
    }
  });

  it("provisions local Prometheus alert rules for MVP telemetry risks", () => {
    const compose = readFileSync(COMPOSE_FILE, "utf8");
    const prometheus = readFileSync(PROMETHEUS_CONFIG_FILE, "utf8");
    const rules = readFileSync(PROMETHEUS_RULES_FILE, "utf8");

    expect(compose).toContain(
      "./infra/observability/prometheus-rules.yaml:/etc/prometheus/prometheus-rules.yaml:ro",
    );
    expect(prometheus).toContain("rule_files:");
    expect(prometheus).toContain("/etc/prometheus/prometheus-rules.yaml");

    for (const alert of EXPECTED_PROMETHEUS_ALERTS) {
      expect(rules).toContain(`alert: ${alert.alert}`);
      expect(rules).toContain(alert.metric);
      expect(rules).toContain(alert.runbook);
    }
  });
});
