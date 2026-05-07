import { createObservabilityRuntime, OBSERVABILITY_METRIC_NAMES } from "@repo/observability";
import { createApiApp } from "./app";

const observability = createObservabilityRuntime({
  defaultServiceName: "code-review-api",
});
const app = createApiApp({
  adminObservabilitySink: observability.adminControlPlaneSink,
}).listen({
  hostname: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
});

console.log(`api listening on ${app.server?.hostname}:${app.server?.port}`);
observability.logger.info("api service started", {
  attributes: {
    "event.name": "api.service.started",
    "http.host": app.server?.hostname,
    "http.port": app.server?.port,
  },
});
observability.metrics.count(OBSERVABILITY_METRIC_NAMES.apiServiceStartsTotal, {
  labels: { status: "started" },
});

/** Flushes observability providers before process shutdown. */
const shutdown = async (): Promise<void> => {
  observability.logger.info("api service stopping", {
    attributes: { "event.name": "api.service.stopping" },
  });
  observability.metrics.count(OBSERVABILITY_METRIC_NAMES.apiServiceStopsTotal, {
    labels: { status: "stopping" },
  });
  await observability.shutdown();
  process.exit(0);
};

process.on("SIGTERM", () => {
  shutdown().catch((error: unknown) => {
    console.error("api shutdown failed", error);
    process.exit(1);
  });
});
process.on("SIGINT", () => {
  shutdown().catch((error: unknown) => {
    console.error("api shutdown failed", error);
    process.exit(1);
  });
});
