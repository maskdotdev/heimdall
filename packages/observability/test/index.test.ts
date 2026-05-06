import { describe, expect, it } from "vitest";
import {
  createMemoryObservabilitySink,
  normalizeAdminControlPlaneTelemetryEvent,
  recordAdminControlPlaneTelemetryEvent,
  summarizeAdminControlPlaneTelemetry,
} from "../src";

describe("admin control-plane telemetry", () => {
  it("normalizes and records events", () => {
    const sink = createMemoryObservabilitySink();
    const event = recordAdminControlPlaneTelemetryEvent(sink, {
      attributes: { code: "admin.forbidden", permission: "admin.replay.execute" },
      name: "admin.access.denied",
      requestId: "req_1",
      route: "/admin/debug/webhooks/webhook_1/replay",
      statusCode: 403,
    });

    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(sink.events()).toEqual([event]);
  });

  it("rejects invalid events", () => {
    expect(() =>
      normalizeAdminControlPlaneTelemetryEvent({
        name: "admin.access.denied",
        statusCode: 99,
        timestamp: "2026-05-06T12:00:00.000Z",
      }),
    ).toThrow(/does not match the schema/);
  });

  it("summarizes release-relevant event counts", () => {
    const summary = summarizeAdminControlPlaneTelemetry([
      {
        attributes: { code: "admin.cors_forbidden" },
        name: "admin.access.denied",
        statusCode: 403,
        timestamp: "2026-05-06T12:00:00.000Z",
      },
      {
        attributes: { code: "admin.cors_forbidden" },
        name: "admin.access.denied",
        statusCode: 403,
        timestamp: "2026-05-06T12:01:00.000Z",
      },
      {
        name: "admin.settings.updated",
        repoId: "repo_1",
        timestamp: "2026-05-06T12:02:00.000Z",
      },
      {
        name: "admin.replay.dispatched",
        repoId: "repo_1",
        timestamp: "2026-05-06T12:03:00.000Z",
      },
    ]);

    expect(summary).toMatchObject({
      accessDeniedCount: 2,
      failuresByCode: { "admin.cors_forbidden": 2 },
      replayDispatchCount: 1,
      settingsUpdateCount: 1,
      totalEvents: 4,
    });
  });
});
