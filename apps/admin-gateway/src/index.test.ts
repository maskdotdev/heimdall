import type { StructuredTelemetryLogger, StructuredTelemetryLogOptions } from "@repo/observability";
import { describe, expect, it } from "vitest";
import { createGitHubAdminGatewayTelemetryLogger } from "./index";

type RecordedLog = {
  /** Structured log level captured by the fake logger. */
  readonly level: "debug" | "error" | "info" | "warn";
  /** Log message captured by the fake logger. */
  readonly message: string;
  /** Structured telemetry options captured by the fake logger. */
  readonly options?: StructuredTelemetryLogOptions;
};

describe("admin gateway observability bootstrap", () => {
  it("adapts gateway logger fields into structured telemetry attributes", () => {
    const records: RecordedLog[] = [];
    const logger = createRecordingLogger(records);
    const gatewayLogger = createGitHubAdminGatewayTelemetryLogger(logger);

    gatewayLogger.info?.("admin gateway assertion issued", {
      githubLogin: "octocat",
      metadata: { nested: true },
      orgIds: ["org_1", "org_2"],
      repoIds: ["repo_1"],
    });

    expect(records).toEqual([
      {
        level: "info",
        message: "admin gateway assertion issued",
        options: {
          attributes: {
            "admin_gateway.githubLogin": "octocat",
            "admin_gateway.metadata_present": true,
            "admin_gateway.orgIds_count": 2,
            "admin_gateway.repoIds_count": 1,
          },
          target: "admin-gateway",
        },
      },
    ]);
  });
});

/** Creates a structured logger that records calls for tests. */
function createRecordingLogger(records: RecordedLog[]): StructuredTelemetryLogger {
  const pushRecord = (
    level: RecordedLog["level"],
    message: string,
    options?: StructuredTelemetryLogOptions,
  ): void => {
    records.push({
      level,
      message,
      ...(options ? { options } : {}),
    });
  };

  return {
    debug: (message, options) => pushRecord("debug", message, options),
    error: (message, options) => pushRecord("error", message, options),
    info: (message, options) => pushRecord("info", message, options),
    warn: (message, options) => pushRecord("warn", message, options),
  };
}
