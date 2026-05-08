import { createDatabaseClient } from "@repo/db";
import { createObservabilityRuntime, OBSERVABILITY_METRIC_NAMES } from "@repo/observability";
import { createApiApp, createPostgresSecurityEventSink } from "./app";

const observability = createObservabilityRuntime({
  defaultServiceName: "code-review-api",
});
const databaseClient = createDatabaseClient();
const app = createApiApp({
  adminObservabilitySink: observability.adminControlPlaneSink,
  adminSecurityEventSink: createPostgresSecurityEventSink({
    db: databaseClient.db,
    onError: (error, event) => {
      observability.logger.warn("security event persistence failed", {
        attributes: {
          "event.id": event.id,
          "event.type": event.type,
        },
        error,
        target: "api.security_events",
      });
    },
  }),
  databaseClient,
  metrics: observability.metrics,
  traces: observability.traces,
}).listen({
  hostname: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
});

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
  await databaseClient.close();
  await observability.shutdown();
  process.exit(0);
};

process.on("SIGTERM", () => {
  shutdown().catch((error: unknown) => {
    observability.logger.error("api shutdown failed", {
      error,
      target: "api.shutdown",
    });
    process.exit(1);
  });
});
process.on("SIGINT", () => {
  shutdown().catch((error: unknown) => {
    observability.logger.error("api shutdown failed", {
      error,
      target: "api.shutdown",
    });
    process.exit(1);
  });
});
