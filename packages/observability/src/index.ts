import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Scalar attribute values allowed in structured telemetry events. */
export const TelemetryAttributeValueSchema = Type.Union([
  Type.Boolean(),
  Type.Number(),
  Type.String(),
]);

/** Admin control-plane telemetry event names emitted by production services. */
export const AdminControlPlaneTelemetryEventNameSchema = Type.Union([
  Type.Literal("admin.access.denied"),
  Type.Literal("admin.auth.success"),
  Type.Literal("admin.replay.dispatched"),
  Type.Literal("admin.session.revoked"),
  Type.Literal("admin.settings.updated"),
]);

/** Structured admin control-plane telemetry event. */
export const AdminControlPlaneTelemetryEventSchema = Type.Object(
  {
    actorUserId: Type.Optional(Type.String({ minLength: 1 })),
    attributes: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), TelemetryAttributeValueSchema),
    ),
    name: AdminControlPlaneTelemetryEventNameSchema,
    orgId: Type.Optional(Type.String({ minLength: 1 })),
    repoId: Type.Optional(Type.String({ minLength: 1 })),
    requestId: Type.Optional(Type.String({ minLength: 1 })),
    route: Type.Optional(Type.String({ minLength: 1 })),
    statusCode: Type.Optional(Type.Number({ minimum: 100, maximum: 599 })),
    timestamp: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** Scalar attribute value allowed in structured telemetry events. */
export type TelemetryAttributeValue = Static<typeof TelemetryAttributeValueSchema>;

/** Admin control-plane telemetry event name. */
export type AdminControlPlaneTelemetryEventName = Static<
  typeof AdminControlPlaneTelemetryEventNameSchema
>;

/** Structured admin control-plane telemetry event. */
export type AdminControlPlaneTelemetryEvent = Static<typeof AdminControlPlaneTelemetryEventSchema>;

/** Admin control-plane telemetry event accepted before timestamp normalization. */
export type AdminControlPlaneTelemetryEventInput = Omit<
  AdminControlPlaneTelemetryEvent,
  "timestamp"
> & {
  /** ISO timestamp for the event. */
  readonly timestamp?: string;
};

/** Sink that receives normalized observability events. */
export type ObservabilitySink = {
  /** Records one normalized admin control-plane event. */
  readonly record: (event: AdminControlPlaneTelemetryEvent) => void;
};

/** In-memory sink used by tests and local audits. */
export type MemoryObservabilitySink = ObservabilitySink & {
  /** Removes all recorded events from the sink. */
  readonly clear: () => void;
  /** Returns recorded events in insertion order. */
  readonly events: () => readonly AdminControlPlaneTelemetryEvent[];
};

/** Console logger surface used by the console sink. */
export type ObservabilityConsoleLogger = {
  /** Emits an informational structured telemetry line. */
  readonly info: (message?: unknown, ...optionalParams: readonly unknown[]) => void;
  /** Emits a warning structured telemetry line. */
  readonly warn: (message?: unknown, ...optionalParams: readonly unknown[]) => void;
};

/** Summary of admin control-plane telemetry used by release audits. */
export type AdminControlPlaneTelemetrySummary = {
  /** Count of denied access events. */
  readonly accessDeniedCount: number;
  /** Event count by telemetry name. */
  readonly eventsByName: Readonly<Record<AdminControlPlaneTelemetryEventName, number>>;
  /** Denied access count by error code. */
  readonly failuresByCode: Readonly<Record<string, number>>;
  /** Count of replay dispatch events. */
  readonly replayDispatchCount: number;
  /** Count of settings mutation events. */
  readonly settingsUpdateCount: number;
  /** Total number of telemetry events. */
  readonly totalEvents: number;
};

/** Creates a sink that intentionally drops events. */
export function createNoopObservabilitySink(): ObservabilitySink {
  return {
    record: () => undefined,
  };
}

/** Creates an in-memory observability sink. */
export function createMemoryObservabilitySink(
  initialEvents: readonly AdminControlPlaneTelemetryEvent[] = [],
): MemoryObservabilitySink {
  const recordedEvents = [...initialEvents.map(normalizeAdminControlPlaneTelemetryEvent)];
  return {
    clear: () => {
      recordedEvents.length = 0;
    },
    events: () => [...recordedEvents],
    record: (event) => {
      recordedEvents.push(normalizeAdminControlPlaneTelemetryEvent(event));
    },
  };
}

/** Creates a console-backed observability sink for production services. */
export function createConsoleObservabilitySink(
  logger: ObservabilityConsoleLogger = console,
): ObservabilitySink {
  return {
    record: (event) => {
      const normalizedEvent = normalizeAdminControlPlaneTelemetryEvent(event);
      const line = JSON.stringify({
        event: normalizedEvent,
        level: telemetryLogLevel(normalizedEvent),
        target: "heimdall.admin_control_plane",
      });
      if (telemetryLogLevel(normalizedEvent) === "warn") {
        logger.warn(line);
        return;
      }

      logger.info(line);
    },
  };
}

/** Records a normalized admin control-plane telemetry event. */
export function recordAdminControlPlaneTelemetryEvent(
  sink: ObservabilitySink,
  event: AdminControlPlaneTelemetryEventInput,
): AdminControlPlaneTelemetryEvent {
  const normalizedEvent = normalizeAdminControlPlaneTelemetryEvent(event);
  sink.record(normalizedEvent);
  return normalizedEvent;
}

/** Records telemetry and suppresses sink failures so production requests are not blocked. */
export function tryRecordAdminControlPlaneTelemetryEvent(
  sink: ObservabilitySink,
  event: AdminControlPlaneTelemetryEventInput,
): boolean {
  try {
    recordAdminControlPlaneTelemetryEvent(sink, event);
    return true;
  } catch {
    return false;
  }
}

/** Normalizes and validates an admin control-plane telemetry event. */
export function normalizeAdminControlPlaneTelemetryEvent(
  event: AdminControlPlaneTelemetryEventInput,
): AdminControlPlaneTelemetryEvent {
  const normalizedEvent = withoutUndefinedValues({
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  });
  if (!Value.Check(AdminControlPlaneTelemetryEventSchema, normalizedEvent)) {
    throw new Error("Admin control-plane telemetry event does not match the schema.");
  }
  const timestamp = normalizedEvent.timestamp;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw new Error("Admin control-plane telemetry event timestamp must be parseable.");
  }

  return normalizedEvent as AdminControlPlaneTelemetryEvent;
}

/** Builds a compact summary of admin control-plane telemetry. */
export function summarizeAdminControlPlaneTelemetry(
  events: readonly AdminControlPlaneTelemetryEventInput[],
): AdminControlPlaneTelemetrySummary {
  const normalizedEvents = events.map(normalizeAdminControlPlaneTelemetryEvent);
  const eventsByName = emptyEventCounts();
  const failuresByCode: Record<string, number> = {};

  for (const event of normalizedEvents) {
    eventsByName[event.name] += 1;
    if (event.name === "admin.access.denied") {
      const code = typeof event.attributes?.code === "string" ? event.attributes.code : "unknown";
      failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;
    }
  }

  return {
    accessDeniedCount: eventsByName["admin.access.denied"],
    eventsByName,
    failuresByCode,
    replayDispatchCount: eventsByName["admin.replay.dispatched"],
    settingsUpdateCount: eventsByName["admin.settings.updated"],
    totalEvents: normalizedEvents.length,
  };
}

/** Returns an empty event-count map with all known event names initialized. */
function emptyEventCounts(): Record<AdminControlPlaneTelemetryEventName, number> {
  return {
    "admin.access.denied": 0,
    "admin.auth.success": 0,
    "admin.replay.dispatched": 0,
    "admin.session.revoked": 0,
    "admin.settings.updated": 0,
  };
}

/** Returns the log level for one telemetry event. */
function telemetryLogLevel(event: AdminControlPlaneTelemetryEvent): "info" | "warn" {
  return event.name === "admin.access.denied" || (event.statusCode ?? 0) >= 400 ? "warn" : "info";
}

/** Removes undefined optional fields before schema validation. */
function withoutUndefinedValues(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
