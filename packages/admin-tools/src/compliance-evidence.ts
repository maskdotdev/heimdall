import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ComplianceEvidenceRecord,
  ComplianceEvidenceRepository,
  type HeimdallDatabase,
} from "@repo/db";
import {
  type ComplianceControlId,
  type ComplianceEvidenceDescriptor,
  type ComplianceEvidenceType,
  createComplianceEvidenceDescriptor,
} from "@repo/security";

/** Maximum rows one compliance evidence collector can export in one artifact. */
const MAX_COMPLIANCE_EVIDENCE_EXPORT_ROWS = 1_000;

/** Schema version for generated compliance evidence artifact payloads. */
const COMPLIANCE_EVIDENCE_ARTIFACT_SCHEMA_VERSION = "compliance_evidence_artifact.v1";

/** Input used to write one compliance evidence artifact payload. */
export type ComplianceEvidenceArtifactWriteInput = {
  /** Stable evidence row ID used for artifact naming. */
  readonly evidenceId: string;
  /** Stable control ID this artifact supports. */
  readonly controlId: ComplianceControlId;
  /** Evidence artifact type being written. */
  readonly evidenceType: ComplianceEvidenceType;
  /** Organization scope when the artifact is tenant-specific. */
  readonly orgId?: string | undefined;
  /** ISO timestamp when collection happened. */
  readonly collectedAt: string;
  /** JSON-compatible payload to persist. */
  readonly payload: ComplianceEvidenceArtifactPayload;
};

/** Result returned after writing one compliance evidence artifact. */
export type ComplianceEvidenceArtifactWriteResult = {
  /** Durable URI for the written artifact. */
  readonly uri: string;
  /** SHA-256 digest of the written artifact bytes. */
  readonly sha256: string;
  /** Size of the written artifact in bytes. */
  readonly sizeBytes: number;
};

/** Artifact-store boundary for compliance evidence payloads. */
export type ComplianceEvidenceArtifactStore = {
  /** Writes one compliance evidence payload and returns a durable artifact reference. */
  readonly write: (
    input: ComplianceEvidenceArtifactWriteInput,
  ) => Promise<ComplianceEvidenceArtifactWriteResult>;
};

/** In-memory compliance evidence artifact retained for tests and local dry-runs. */
export type MemoryComplianceEvidenceArtifact = ComplianceEvidenceArtifactWriteInput &
  ComplianceEvidenceArtifactWriteResult;

/** In-memory compliance evidence artifact store used by unit tests. */
export type MemoryComplianceEvidenceArtifactStore = ComplianceEvidenceArtifactStore & {
  /** Returns written artifacts in insertion order. */
  readonly artifacts: () => readonly MemoryComplianceEvidenceArtifact[];
  /** Clears all written artifacts. */
  readonly clear: () => void;
};

/** Filesystem-backed compliance evidence artifact store options. */
export type FilesystemComplianceEvidenceArtifactStoreOptions = {
  /** Root directory that receives generated JSON evidence artifacts. */
  readonly rootDir: string;
};

/** JSON payload written for one compliance evidence collection. */
export type ComplianceEvidenceArtifactPayload = {
  /** Artifact schema version. */
  readonly schemaVersion: typeof COMPLIANCE_EVIDENCE_ARTIFACT_SCHEMA_VERSION;
  /** Stable control ID this artifact supports. */
  readonly controlId: ComplianceControlId;
  /** Evidence artifact type. */
  readonly evidenceType: ComplianceEvidenceType;
  /** Organization scope when tenant-specific. */
  readonly orgId?: string | undefined;
  /** ISO timestamp when collection happened. */
  readonly collectedAt: string;
  /** Product-safe collector summary. */
  readonly summary: Readonly<Record<string, string | number | boolean>>;
  /** Product-safe evidence records. */
  readonly records: readonly Readonly<Record<string, unknown>>[];
};

/** Options shared by compliance evidence collector functions. */
export type ComplianceEvidenceCollectorOptions = {
  /** Database facade used to read source rows and persist evidence metadata. */
  readonly db: HeimdallDatabase;
  /** Artifact store that receives the generated evidence JSON payload. */
  readonly artifactStore: ComplianceEvidenceArtifactStore;
  /** Organization scope to collect, when tenant-specific. */
  readonly orgId?: string | undefined;
  /** Actor, service, or automation that collected the evidence. */
  readonly collectedBy: string;
  /** Optional row limit. Defaults to 100 and cannot exceed 1000. */
  readonly limit?: number | undefined;
  /** Current time provider used by tests. */
  readonly now?: (() => Date) | undefined;
};

/** Result returned by one compliance evidence collector. */
export type CollectedComplianceEvidence = {
  /** Normalized descriptor passed to durable persistence. */
  readonly descriptor: ComplianceEvidenceDescriptor;
  /** Written artifact metadata. */
  readonly artifact: ComplianceEvidenceArtifactWriteResult;
  /** Persisted compliance evidence row. */
  readonly record: ComplianceEvidenceRecord;
  /** Product-safe JSON payload written to the artifact store. */
  readonly payload: ComplianceEvidenceArtifactPayload;
};

/** Creates an in-memory compliance evidence artifact store. */
export function createMemoryComplianceEvidenceArtifactStore(): MemoryComplianceEvidenceArtifactStore {
  const artifacts: MemoryComplianceEvidenceArtifact[] = [];

  return {
    artifacts: () => [...artifacts],
    clear: () => {
      artifacts.length = 0;
    },
    write: async (input) => {
      const bytes = Buffer.from(JSON.stringify(input.payload, null, 2), "utf8");
      const result = {
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
        uri: `memory://compliance-evidence/${input.evidenceId}.json`,
      };
      artifacts.push({ ...input, ...result });
      return result;
    },
  };
}

/** Creates a filesystem-backed compliance evidence artifact store. */
export function createFilesystemComplianceEvidenceArtifactStore(
  options: FilesystemComplianceEvidenceArtifactStoreOptions,
): ComplianceEvidenceArtifactStore {
  return {
    write: async (input) => {
      const directory = join(
        options.rootDir,
        safeEvidencePathSegment(input.orgId ?? "global"),
        safeEvidencePathSegment(input.controlId),
        safeEvidencePathSegment(input.evidenceType),
      );
      await mkdir(directory, { recursive: true });

      const fileName = `${safeEvidencePathSegment(input.collectedAt)}-${safeEvidencePathSegment(
        input.evidenceId,
      )}.json`;
      const filePath = join(directory, fileName);
      const bytes = Buffer.from(JSON.stringify(input.payload, null, 2), "utf8");
      await writeFile(filePath, bytes);

      return {
        sha256: sha256(bytes),
        sizeBytes: bytes.byteLength,
        uri: pathToFileURL(filePath).toString(),
      };
    },
  };
}

/** Collects a product-safe access review evidence export. */
export async function collectAccessReviewEvidence(
  options: ComplianceEvidenceCollectorOptions,
): Promise<CollectedComplianceEvidence> {
  const collectedAt = collectorTimestamp(options);
  const limit = collectorLimit(options.limit);
  const rows = await new ComplianceEvidenceRepository(options.db).listAccessReviewEvidenceRows({
    limit,
    orgId: options.orgId,
  });

  const records = rows.map((row) => ({
    createdAt: row.createdAt.toISOString(),
    orgId: row.orgId,
    role: row.role,
    updatedAt: row.updatedAt.toISOString(),
    userId: row.userId,
  }));

  return persistCollectedComplianceEvidence(options, {
    collectedAt,
    controlId: "soc2.cc6.1.access_review",
    evidenceType: "access_review_export",
    records,
    summary: {
      membershipCount: records.length,
      orgScoped: Boolean(options.orgId),
    },
  });
}

/** Collects a product-safe audit log evidence export. */
export async function collectAuditLogEvidence(
  options: ComplianceEvidenceCollectorOptions,
): Promise<CollectedComplianceEvidence> {
  const collectedAt = collectorTimestamp(options);
  const limit = collectorLimit(options.limit);
  const rows = await new ComplianceEvidenceRepository(options.db).listAuditLogEvidenceRows({
    limit,
    orgId: options.orgId,
  });

  const records = rows.map((row) => ({
    action: row.action,
    actorType: row.actorType,
    actorUserId: row.actorUserId ?? undefined,
    auditLogId: row.auditLogId,
    metadataKeys: objectKeys(row.metadata),
    occurredAt: row.occurredAt.toISOString(),
    orgId: row.orgId ?? undefined,
    resourceId: row.resourceId ?? undefined,
    resourceType: row.resourceType,
  }));

  return persistCollectedComplianceEvidence(options, {
    collectedAt,
    controlId: "soc2.cc7.2.audit_logging",
    evidenceType: "audit_log_export",
    records,
    summary: {
      auditLogCount: records.length,
      orgScoped: Boolean(options.orgId),
    },
  });
}

/** Collects a product-safe security event evidence export. */
export async function collectSecurityEventEvidence(
  options: ComplianceEvidenceCollectorOptions,
): Promise<CollectedComplianceEvidence> {
  const collectedAt = collectorTimestamp(options);
  const limit = collectorLimit(options.limit);
  const rows = await new ComplianceEvidenceRepository(options.db).listSecurityEventEvidenceRows({
    limit,
    orgId: options.orgId,
  });

  const records = rows.map((row) => ({
    actorId: row.actorId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    metadataKeys: objectKeys(row.metadata),
    orgId: row.orgId ?? undefined,
    repoId: row.repoId ?? undefined,
    resourceId: row.resourceId ?? undefined,
    resourceType: row.resourceType ?? undefined,
    securityEventId: row.securityEventId,
    severity: row.severity,
    source: row.source,
    status: row.status,
    type: row.type,
  }));

  return persistCollectedComplianceEvidence(options, {
    collectedAt,
    controlId: "nist.ssdf.po.5.security_events",
    evidenceType: "security_event_export",
    records,
    summary: {
      orgScoped: Boolean(options.orgId),
      securityEventCount: records.length,
    },
  });
}

/** Collects a product-safe configuration snapshot evidence export. */
export async function collectConfigSnapshotEvidence(
  options: ComplianceEvidenceCollectorOptions,
): Promise<CollectedComplianceEvidence> {
  const collectedAt = collectorTimestamp(options);
  const limit = collectorLimit(options.limit);
  const { orgSettingsRows, repositoryRows, repositorySettingsRows } =
    await new ComplianceEvidenceRepository(options.db).listConfigSnapshotEvidenceRows({
      limit,
      orgId: options.orgId,
    });
  const scopedRepoIds = new Set(repositoryRows.map((row) => row.repoId));
  const repoOrgById = new Map(repositoryRows.map((row) => [row.repoId, row.orgId]));

  const records = [
    ...orgSettingsRows.map((row) => ({
      configType: "org_settings",
      orgId: row.orgId,
      settingsKeys: objectKeys(row.settingsJson),
      updatedAt: row.updatedAt.toISOString(),
      updatedByUserId: row.updatedByUserId ?? undefined,
      version: row.version,
    })),
    ...repositorySettingsRows
      .filter((row) => !options.orgId || scopedRepoIds.has(row.repoId))
      .map((row) => ({
        configType: "repository_settings",
        customInstructionsHash:
          row.customInstructions && row.customInstructions.length > 0
            ? sha256(Buffer.from(row.customInstructions, "utf8"))
            : undefined,
        customInstructionsLength: row.customInstructions?.length ?? 0,
        ignoredAuthorCount: arrayLength(row.ignoredAuthors),
        ignoredLabelCount: arrayLength(row.ignoredLabels),
        ignoredPathCount: arrayLength(row.ignoredPaths),
        maxCommentsPerReview: row.maxCommentsPerReview,
        orgId: repoOrgById.get(row.repoId),
        repoId: row.repoId,
        requireLabelConfigured: Boolean(row.requireLabel),
        reviewPolicy: row.reviewPolicy,
        sandboxPolicyKeys: objectKeys(row.sandboxPolicy),
        severityThreshold: row.severityThreshold,
        skipDraftPullRequests: row.skipDraftPullRequests,
        skipGeneratedFiles: row.skipGeneratedFiles,
        updatedAt: row.updatedAt.toISOString(),
      })),
  ];

  return persistCollectedComplianceEvidence(options, {
    collectedAt,
    controlId: "soc2.cc8.1.change_management",
    evidenceType: "config_snapshot",
    records,
    summary: {
      configRecordCount: records.length,
      orgScoped: Boolean(options.orgId),
      repositoryCount: repositoryRows.length,
    },
  });
}

/** Input used to persist a generated evidence artifact and durable row. */
type PersistCollectedComplianceEvidenceInput = {
  /** ISO timestamp when collection happened. */
  readonly collectedAt: string;
  /** Stable control ID this artifact supports. */
  readonly controlId: ComplianceControlId;
  /** Evidence artifact type. */
  readonly evidenceType: ComplianceEvidenceType;
  /** Product-safe evidence records. */
  readonly records: readonly Readonly<Record<string, unknown>>[];
  /** Product-safe collector summary. */
  readonly summary: Readonly<Record<string, string | number | boolean>>;
};

/** Persists a generated evidence payload and records its durable descriptor. */
async function persistCollectedComplianceEvidence(
  options: ComplianceEvidenceCollectorOptions,
  input: PersistCollectedComplianceEvidenceInput,
): Promise<CollectedComplianceEvidence> {
  const evidenceId = newComplianceEvidenceId();
  const payload = {
    collectedAt: input.collectedAt,
    controlId: input.controlId,
    evidenceType: input.evidenceType,
    records: input.records,
    schemaVersion: COMPLIANCE_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    summary: input.summary,
    ...(options.orgId ? { orgId: options.orgId } : {}),
  } satisfies ComplianceEvidenceArtifactPayload;
  const artifact = await options.artifactStore.write({
    collectedAt: input.collectedAt,
    controlId: input.controlId,
    evidenceId,
    evidenceType: input.evidenceType,
    payload,
    ...(options.orgId ? { orgId: options.orgId } : {}),
  });
  const descriptor = createComplianceEvidenceDescriptor({
    collectedAt: input.collectedAt,
    collectedBy: options.collectedBy,
    controlId: input.controlId,
    evidenceHash: artifact.sha256,
    evidenceType: input.evidenceType,
    evidenceUri: artifact.uri,
    id: evidenceId,
    metadata: {
      sizeBytes: artifact.sizeBytes,
    },
    source: "admin_tool",
    summary: input.summary,
    ...(options.orgId ? { orgId: options.orgId } : {}),
  });
  const record = await new ComplianceEvidenceRepository(options.db).recordComplianceEvidence({
    collectedAt: descriptor.collectedAt,
    collectedBy: descriptor.collectedBy,
    complianceEvidenceId: descriptor.id,
    controlId: descriptor.controlId,
    evidenceHash: descriptor.evidenceHash,
    evidenceType: descriptor.evidenceType,
    evidenceUri: descriptor.evidenceUri,
    metadata: descriptor.metadata,
    orgId: descriptor.orgId,
    source: descriptor.source,
    status: descriptor.status,
    summary: descriptor.summary,
  });

  return { artifact, descriptor, payload, record };
}

/** Returns the collector timestamp as an ISO string. */
function collectorTimestamp(options: Pick<ComplianceEvidenceCollectorOptions, "now">): string {
  return (options.now?.() ?? new Date()).toISOString();
}

/** Validates and returns the collector row limit. */
function collectorLimit(limit: number | undefined): number {
  const normalized = limit ?? 100;
  if (
    !Number.isInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_COMPLIANCE_EVIDENCE_EXPORT_ROWS
  ) {
    throw new Error(
      `Compliance evidence collector limit must be an integer from 1 to ${MAX_COMPLIANCE_EVIDENCE_EXPORT_ROWS}.`,
    );
  }

  return normalized;
}

/** Creates a durable compliance evidence ID. */
function newComplianceEvidenceId(): string {
  return `cmpev_${randomUUID().replaceAll("-", "")}`;
}

/** Returns sorted object keys for product-safe evidence summaries. */
function objectKeys(value: unknown): readonly string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
}

/** Returns an array length from unknown JSON-compatible input. */
function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Returns a SHA-256 digest for artifact bytes. */
function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Sanitizes one path segment used by local filesystem evidence artifacts. */
function safeEvidencePathSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/gu, "_").slice(0, 160) || "unknown";
}
