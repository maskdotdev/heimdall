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

/** Query helper for durable security and audit event writes. */
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
}
