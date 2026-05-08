import {
  createObservabilityRuntime,
  type StructuredTelemetryLogger,
  type StructuredTelemetryLogOptions,
  type TelemetryAttributeValue,
} from "@repo/observability";
import {
  createGitHubAdminGateway,
  type GitHubAdminGatewayLogger,
  readGitHubAdminGatewayConfig,
} from "./github-admin-gateway";

export {
  createGitHubAdminGateway,
  type GitHubAdminGateway,
  type GitHubAdminGatewayConfig,
  type GitHubAdminGatewayLogger,
  readGitHubAdminGatewayConfig,
} from "./github-admin-gateway";

/** Creates a gateway logger backed by the shared structured telemetry facade. */
export function createGitHubAdminGatewayTelemetryLogger(
  logger: StructuredTelemetryLogger,
): GitHubAdminGatewayLogger {
  return {
    error: (message, fields) => {
      logger.error(message, createGatewayLogOptions(fields));
    },
    info: (message, fields) => {
      logger.info(message, createGatewayLogOptions(fields));
    },
    warn: (message, fields) => {
      logger.warn(message, createGatewayLogOptions(fields));
    },
  };
}

/** Builds structured telemetry log options for gateway operator events. */
function createGatewayLogOptions(fields?: Record<string, unknown>): StructuredTelemetryLogOptions {
  const attributes = normalizeGatewayLogAttributes(fields);

  return {
    ...(attributes ? { attributes } : {}),
    target: "admin-gateway",
  };
}

/** Normalizes gateway logger fields into product-safe telemetry attributes. */
function normalizeGatewayLogAttributes(
  fields?: Record<string, unknown>,
): Readonly<Record<string, TelemetryAttributeValue>> | undefined {
  if (!fields) {
    return undefined;
  }

  const attributes: Record<string, TelemetryAttributeValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) {
      continue;
    }

    const attributeKey = `admin_gateway.${key}`;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attributes[attributeKey] = value;
      continue;
    }

    if (Array.isArray(value)) {
      attributes[`${attributeKey}_count`] = value.length;
      continue;
    }

    attributes[`${attributeKey}_present`] = true;
  }

  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

if (import.meta.main) {
  const observability = createObservabilityRuntime({
    defaultServiceName: "heimdall-admin-gateway",
  });
  const config = readGitHubAdminGatewayConfig();
  const gateway = createGitHubAdminGateway(config, {
    logger: createGitHubAdminGatewayTelemetryLogger(observability.logger),
  });
  const server = Bun.serve({
    fetch: gateway.handle,
    hostname: config.host,
    port: config.port,
  });

  observability.logger.info("admin gateway service started", {
    attributes: {
      "admin_gateway.host": server.hostname,
      "admin_gateway.port": server.port,
    },
    target: "admin-gateway",
  });

  /** Stops the admin gateway and flushes telemetry providers before process shutdown. */
  const shutdown = async (): Promise<void> => {
    observability.logger.info("admin gateway service stopping", {
      target: "admin-gateway",
    });
    server.stop(true);
    await observability.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    shutdown().catch((error: unknown) => {
      observability.logger.error("admin gateway shutdown failed", {
        error,
        target: "admin-gateway",
      });
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    shutdown().catch((error: unknown) => {
      observability.logger.error("admin gateway shutdown failed", {
        error,
        target: "admin-gateway",
      });
      process.exit(1);
    });
  });
}
