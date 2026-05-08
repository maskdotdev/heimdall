import { and, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { artifactAccessEvents, auditLogs, securityEvents } from "../schema";

/** Input used to record one sensitive artifact access event. */
export type RecordArtifactAccessEventInput = {
  /** Stable artifact access event ID. */
  readonly artifactAccessEventId: string;
  /** Actor type that accessed the artifact. */
  readonly actorType: string;
  /** Actor user ID that accessed the artifact. */
  readonly actorUserId: string;
  /** Organization that owns the artifact when known. */
  readonly orgId?: string | null | undefined;
  /** Repository that owns the artifact when known. */
  readonly repoId?: string | null | undefined;
  /** Review run that produced the artifact when known. */
  readonly reviewRunId?: string | null | undefined;
  /** Product-safe artifact reference summary. */
  readonly artifactRef: unknown;
  /** Access level granted for the artifact. */
  readonly accessLevel: string;
  /** Support session ID when support access was used. */
  readonly supportSessionId?: string | null | undefined;
  /** Human-readable access reason. */
  readonly reason: string;
  /** Caller IP address when available. */
  readonly ipAddress?: string | null | undefined;
  /** Caller user agent when available. */
  readonly userAgent?: string | null | undefined;
  /** Access event creation timestamp. Defaults to the database clock. */
  readonly createdAt?: Date | string | undefined;
};

/** Input used to record one normalized security event. */
export type RecordSecurityEventInput = {
  /** Stable security event ID. */
  readonly securityEventId: string;
  /** Organization scope when present. */
  readonly orgId?: string | null | undefined;
  /** Repository scope when present. */
  readonly repoId?: string | null | undefined;
  /** Security event type. */
  readonly type: string;
  /** Event severity. */
  readonly severity: string;
  /** Event source subsystem. */
  readonly source: string;
  /** Triage status. */
  readonly status: string;
  /** Actor ID when known. */
  readonly actorId?: string | null | undefined;
  /** Resource type when known. */
  readonly resourceType?: string | null | undefined;
  /** Resource ID when known. */
  readonly resourceId?: string | null | undefined;
  /** Product-safe event metadata. */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Event creation timestamp. */
  readonly createdAt: Date | string;
};

/** Input used to insert one security/compliance audit log row. */
export type RecordAuditLogInput = {
  /** Stable audit log ID. */
  readonly auditLogId: string;
  /** Organization scope when present. */
  readonly orgId?: string | null | undefined;
  /** Actor type that performed the action. */
  readonly actorType: string;
  /** Actor user ID when present. */
  readonly actorUserId?: string | null | undefined;
  /** Audited action name. */
  readonly action: string;
  /** Resource type affected by the action. */
  readonly resourceType: string;
  /** Resource ID affected by the action when present. */
  readonly resourceId?: string | null | undefined;
  /** Action occurrence timestamp. */
  readonly occurredAt: Date | string;
  /** Product-safe audit metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | null | undefined;
};

/** Audit log row returned after insertion. */
export type AuditLogRecord = {
  /** Stable audit log ID. */
  readonly auditLogId: string;
  /** Organization scope when present. */
  readonly orgId: string | null;
  /** Actor type that performed the action. */
  readonly actorType: string;
  /** Actor user ID when present. */
  readonly actorUserId: string | null;
  /** Audited action name. */
  readonly action: string;
  /** Resource type affected by the action. */
  readonly resourceType: string;
  /** Resource ID affected by the action when present. */
  readonly resourceId: string | null;
  /** Action occurrence timestamp. */
  readonly occurredAt: Date;
  /** Product-safe audit metadata. */
  readonly metadata: unknown;
};

/** Input used to list audit logs with scoped filters. */
export type ListAuditLogsInput = {
  /** Organization filter. */
  readonly orgId?: string | undefined;
  /** Resource type filter. */
  readonly resourceType?: string | undefined;
  /** Resource ID filter. */
  readonly resourceId?: string | undefined;
  /** Actor user ID filter. */
  readonly actorUserId?: string | undefined;
  /** Action filter. */
  readonly action?: string | undefined;
  /** Free-text search over action, resource, actor, and metadata. */
  readonly search?: string | undefined;
  /** Maximum number of rows to return. */
  readonly limit: number;
};

/** Security event row returned by admin inspection queries. */
export type SecurityEventRecord = {
  /** Stable security event ID. */
  readonly securityEventId: string;
  /** Organization scope when present. */
  readonly orgId: string | null;
  /** Repository scope when present. */
  readonly repoId: string | null;
  /** Security event type. */
  readonly type: string;
  /** Event severity. */
  readonly severity: string;
  /** Event source subsystem. */
  readonly source: string;
  /** Triage status. */
  readonly status: string;
  /** Actor ID when known. */
  readonly actorId: string | null;
  /** Resource type when known. */
  readonly resourceType: string | null;
  /** Resource ID when known. */
  readonly resourceId: string | null;
  /** Product-safe event metadata. */
  readonly metadata: unknown;
  /** Event creation timestamp. */
  readonly createdAt: Date;
  /** Event update timestamp. */
  readonly updatedAt: Date;
};

/** Input used to list security events with scoped filters. */
export type ListSecurityEventsInput = {
  /** Organization filter. */
  readonly orgId?: string | undefined;
  /** Repository filter. */
  readonly repoId?: string | undefined;
  /** Security event type filter. */
  readonly type?: string | undefined;
  /** Severity filter. */
  readonly severity?: string | undefined;
  /** Source subsystem filter. */
  readonly source?: string | undefined;
  /** Triage status filter. */
  readonly status?: string | undefined;
  /** Actor ID filter. */
  readonly actorId?: string | undefined;
  /** Resource type filter. */
  readonly resourceType?: string | undefined;
  /** Resource ID filter. */
  readonly resourceId?: string | undefined;
  /** Free-text search over type, actor, resource, and metadata. */
  readonly search?: string | undefined;
  /** Maximum number of rows to return. */
  readonly limit: number;
};

/** Query helper for durable security and audit events. */
export class SecurityAuditRepository {
  /** Creates a security audit query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Records one sensitive artifact access event. */
  public async recordArtifactAccessEvent(input: RecordArtifactAccessEventInput): Promise<void> {
    await this.db.insert(artifactAccessEvents).values({
      accessLevel: input.accessLevel,
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      artifactAccessEventId: input.artifactAccessEventId,
      artifactRef: input.artifactRef,
      ...(input.createdAt ? { createdAt: new Date(input.createdAt) } : {}),
      ipAddress: input.ipAddress ?? null,
      orgId: input.orgId ?? null,
      reason: input.reason,
      repoId: input.repoId ?? null,
      reviewRunId: input.reviewRunId ?? null,
      supportSessionId: input.supportSessionId ?? null,
      userAgent: input.userAgent ?? null,
    });
  }

  /** Records one normalized security event and ignores duplicate event IDs. */
  public async recordSecurityEvent(input: RecordSecurityEventInput): Promise<void> {
    const createdAt = new Date(input.createdAt);
    await this.db
      .insert(securityEvents)
      .values({
        actorId: input.actorId ?? null,
        createdAt,
        metadata: input.metadata,
        orgId: input.orgId ?? null,
        repoId: input.repoId ?? null,
        resourceId: input.resourceId ?? null,
        resourceType: input.resourceType ?? null,
        securityEventId: input.securityEventId,
        severity: input.severity,
        source: input.source,
        status: input.status,
        type: input.type,
        updatedAt: createdAt,
      })
      .onConflictDoNothing();
  }

  /** Inserts one security/compliance audit log row. */
  public async recordAuditLog(input: RecordAuditLogInput): Promise<AuditLogRecord> {
    const [row] = await this.db
      .insert(auditLogs)
      .values({
        action: input.action,
        actorType: input.actorType,
        actorUserId: input.actorUserId ?? null,
        auditLogId: input.auditLogId,
        metadata: input.metadata ?? null,
        occurredAt: new Date(input.occurredAt),
        orgId: input.orgId ?? null,
        resourceId: input.resourceId ?? null,
        resourceType: input.resourceType,
      })
      .returning();

    if (!row) {
      throw new Error("Database write did not return an audit log row.");
    }

    return row;
  }

  /** Lists audit logs with scoped filters and deterministic ordering. */
  public async listAuditLogs(input: ListAuditLogsInput): Promise<readonly AuditLogRecord[]> {
    const conditions = auditLogFilters(input);
    return this.db
      .select()
      .from(auditLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.auditLogId))
      .limit(securityAuditListLimit(input.limit));
  }

  /** Lists security events with scoped filters and deterministic ordering. */
  public async listSecurityEvents(
    input: ListSecurityEventsInput,
  ): Promise<readonly SecurityEventRecord[]> {
    const conditions = securityEventFilters(input);
    return this.db
      .select()
      .from(securityEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(securityEvents.createdAt), desc(securityEvents.securityEventId))
      .limit(securityAuditListLimit(input.limit));
  }
}

/** Builds audit log filters for admin inspection. */
function auditLogFilters(input: ListAuditLogsInput): SQL[] {
  const conditions: SQL[] = [];
  if (input.orgId) {
    conditions.push(eq(auditLogs.orgId, input.orgId));
  }
  if (input.resourceType) {
    conditions.push(eq(auditLogs.resourceType, input.resourceType));
  }
  if (input.resourceId) {
    conditions.push(eq(auditLogs.resourceId, input.resourceId));
  }
  if (input.actorUserId) {
    conditions.push(eq(auditLogs.actorUserId, input.actorUserId));
  }
  if (input.action) {
    conditions.push(eq(auditLogs.action, input.action));
  }

  const search = input.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    const searchCondition = or(
      ilike(auditLogs.action, pattern),
      ilike(auditLogs.resourceType, pattern),
      ilike(auditLogs.resourceId, pattern),
      ilike(auditLogs.actorUserId, pattern),
      ilike(sql<string>`${auditLogs.metadata}::text`, pattern),
    );
    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }

  return conditions;
}

/** Builds security event filters for admin inspection. */
function securityEventFilters(input: ListSecurityEventsInput): SQL[] {
  const conditions: SQL[] = [];
  if (input.orgId) {
    conditions.push(eq(securityEvents.orgId, input.orgId));
  }
  if (input.repoId) {
    conditions.push(eq(securityEvents.repoId, input.repoId));
  }
  if (input.type) {
    conditions.push(eq(securityEvents.type, input.type));
  }
  if (input.severity) {
    conditions.push(eq(securityEvents.severity, input.severity));
  }
  if (input.source) {
    conditions.push(eq(securityEvents.source, input.source));
  }
  if (input.status) {
    conditions.push(eq(securityEvents.status, input.status));
  }
  if (input.actorId) {
    conditions.push(eq(securityEvents.actorId, input.actorId));
  }
  if (input.resourceType) {
    conditions.push(eq(securityEvents.resourceType, input.resourceType));
  }
  if (input.resourceId) {
    conditions.push(eq(securityEvents.resourceId, input.resourceId));
  }

  const search = input.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    const searchCondition = or(
      ilike(securityEvents.securityEventId, pattern),
      ilike(securityEvents.type, pattern),
      ilike(securityEvents.severity, pattern),
      ilike(securityEvents.source, pattern),
      ilike(securityEvents.status, pattern),
      ilike(securityEvents.actorId, pattern),
      ilike(securityEvents.resourceType, pattern),
      ilike(securityEvents.resourceId, pattern),
      ilike(sql<string>`${securityEvents.metadata}::text`, pattern),
    );
    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }

  return conditions;
}

/** Validates a bounded security/audit inspection list limit. */
function securityAuditListLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Security audit list limit must be an integer from 1 through 100.");
  }
  return limit;
}
