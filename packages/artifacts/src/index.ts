import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Metadata key that stores the legacy inline JSON payload for a review artifact. */
export const REVIEW_ARTIFACT_INLINE_PAYLOAD_METADATA_KEY = "payload" as const;

/** Metadata key that describes where a review artifact payload is stored. */
export const REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY = "payloadStorage" as const;

/** Metadata key that records payload deletion without retaining payload bytes. */
export const REVIEW_ARTIFACT_PAYLOAD_DELETION_METADATA_KEY = "payloadDeletion" as const;

/** Storage mode used by the database-backed JSON payload fallback. */
export const INLINE_REVIEW_ARTIFACT_STORAGE_MODE = "inline_db" as const;

/** Storage mode reserved for object-storage-backed payloads. */
export const OBJECT_REVIEW_ARTIFACT_STORAGE_MODE = "object_storage" as const;

/** Storage mode used for local or shared-volume filesystem payloads. */
export const FILE_SYSTEM_REVIEW_ARTIFACT_STORAGE_MODE = "file_system" as const;

/** URI prefix used by the database-backed review artifact fallback. */
export const REVIEW_ARTIFACT_DATABASE_URI_PREFIX = "db://review_artifacts/" as const;

/** Media type used for JSON review artifacts. */
export const REVIEW_ARTIFACT_JSON_MEDIA_TYPE = "application/json" as const;

/** SHA-256 hash for an empty request body. */
const SHA256_EMPTY_PAYLOAD =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

/** SigV4 payload marker used for presigned GET URLs. */
const S3_UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD" as const;

/** Maximum S3-compatible presigned URL lifetime in seconds. */
const MAX_S3_PRESIGNED_URL_EXPIRES_SECONDS = 604_800;

/** Storage modes supported by review artifact payload metadata. */
export type ReviewArtifactPayloadStorageMode =
  | typeof INLINE_REVIEW_ARTIFACT_STORAGE_MODE
  | typeof OBJECT_REVIEW_ARTIFACT_STORAGE_MODE
  | typeof FILE_SYSTEM_REVIEW_ARTIFACT_STORAGE_MODE;

/** Metadata descriptor for a stored review artifact payload. */
export type ReviewArtifactPayloadDescriptor = {
  /** Storage backend that owns the payload bytes. */
  readonly mode: ReviewArtifactPayloadStorageMode;
  /** Durable URI for the payload bytes. */
  readonly uri: string;
  /** SHA-256 hash for the serialized payload bytes. */
  readonly hash: `sha256:${string}`;
  /** Serialized payload size in bytes. */
  readonly sizeBytes: number;
  /** Payload media type. */
  readonly mediaType: string;
};

/** Environment values used to choose the runtime artifact payload store. */
export type ReviewArtifactPayloadStoreEnvironment = Readonly<Record<string, string | undefined>>;

/** Fetch-compatible function used by object-storage stores. */
export type ReviewArtifactFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Options for S3-compatible review artifact payload storage. */
export type S3CompatibleReviewArtifactPayloadStoreOptions = {
  /** Bucket that owns review artifact payload objects. */
  readonly bucket: string;
  /** AWS-compatible region for request signing. */
  readonly region: string;
  /** Access key ID for SigV4 signing. */
  readonly accessKeyId: string;
  /** Secret access key for SigV4 signing. */
  readonly secretAccessKey: string;
  /** Optional session token for temporary credentials. */
  readonly sessionToken?: string;
  /** Optional S3-compatible endpoint, such as an R2 endpoint. */
  readonly endpoint?: string;
  /** Optional key prefix within the bucket. */
  readonly keyPrefix?: string;
  /** Whether to address objects as endpoint/bucket/key instead of bucket.endpoint/key. */
  readonly forcePathStyle?: boolean;
  /** Optional fetch implementation for tests. */
  readonly fetch?: ReviewArtifactFetch;
  /** Optional clock for deterministic signing tests. */
  readonly now?: () => Date;
};

/** Stored JSON payload and metadata ready for the review_artifacts row. */
export type ReviewArtifactPayloadRecord = ReviewArtifactPayloadDescriptor & {
  /** Metadata to persist with the review artifact row. */
  readonly metadata: Record<string, unknown>;
};

/** Input used to store a JSON review artifact payload. */
export type StoreJsonReviewArtifactPayloadInput = {
  /** Review run that owns the artifact. */
  readonly reviewRunId: string;
  /** Artifact kind. */
  readonly kind: string;
  /** Human-readable artifact name scoped to the review run and kind. */
  readonly name: string;
  /** JSON-compatible payload to store. */
  readonly payload: unknown;
  /** Optional URI override for custom storage backends. */
  readonly uri?: string;
  /** Optional metadata merged into the persisted artifact row metadata. */
  readonly metadata?: Record<string, unknown>;
};

/** Input used to read a JSON review artifact payload. */
export type ReadJsonReviewArtifactPayloadInput = {
  /** Durable artifact URI from the review_artifacts row. */
  readonly uri: string;
  /** Metadata from the review_artifacts row. */
  readonly metadata: unknown;
};

/** Input used to create a short-lived signed JSON payload URL. */
export type CreateSignedReviewArtifactPayloadUrlInput = {
  /** Durable artifact URI from the review_artifacts row. */
  readonly uri: string;
  /** Metadata from the review_artifacts row. */
  readonly metadata: unknown;
  /** URL lifetime in seconds. Defaults to a short service-chosen lifetime. */
  readonly expiresInSeconds?: number;
  /** Optional response content disposition for browser downloads. */
  readonly responseContentDisposition?: string;
  /** Optional response content type for browser downloads. */
  readonly responseContentType?: string;
};

/** Input used to delete a JSON review artifact payload. */
export type DeleteJsonReviewArtifactPayloadInput = {
  /** Durable artifact URI from the review_artifacts row. */
  readonly uri: string;
  /** Metadata from the review_artifacts row. */
  readonly metadata: unknown;
};

/** Result returned when reading a JSON review artifact payload. */
export type ReadJsonReviewArtifactPayloadResult =
  | {
      /** Whether a readable payload exists. */
      readonly exists: true;
      /** Stored JSON payload. */
      readonly payload: unknown;
    }
  | {
      /** Whether a readable payload exists. */
      readonly exists: false;
    };

/** Result returned when creating a signed JSON payload URL. */
export type CreateSignedReviewArtifactPayloadUrlResult =
  | {
      /** Whether a signed URL could be created for the payload. */
      readonly exists: true;
      /** Short-lived signed URL. */
      readonly url: string;
      /** Timestamp when the signed URL expires. */
      readonly expiresAt: Date;
    }
  | {
      /** Whether a signed URL could be created for the payload. */
      readonly exists: false;
    };

/** Result returned when deleting a JSON review artifact payload. */
export type DeleteJsonReviewArtifactPayloadResult = {
  /** Whether payload bytes or inline metadata were present and removed. */
  readonly deleted: boolean;
};

/** Storage boundary for review artifact JSON payloads. */
export type ReviewArtifactPayloadStore = {
  /** Stores a JSON payload and returns DB metadata plus the durable descriptor. */
  readonly putJson: (
    input: StoreJsonReviewArtifactPayloadInput,
  ) => Promise<ReviewArtifactPayloadRecord>;
  /** Reads a JSON payload using the artifact URI and DB metadata. */
  readonly getJson: (
    input: ReadJsonReviewArtifactPayloadInput,
  ) => Promise<ReadJsonReviewArtifactPayloadResult>;
  /** Deletes a JSON payload from the backing store when payload bytes are present. */
  readonly deleteJson: (
    input: DeleteJsonReviewArtifactPayloadInput,
  ) => Promise<DeleteJsonReviewArtifactPayloadResult>;
  /** Creates a short-lived direct download URL when the backing store supports it. */
  readonly createSignedGetUrl?: (
    input: CreateSignedReviewArtifactPayloadUrlInput,
  ) => Promise<CreateSignedReviewArtifactPayloadUrlResult>;
};

/** Database-backed JSON payload store used until object storage is configured. */
export class InlineReviewArtifactPayloadStore implements ReviewArtifactPayloadStore {
  /** Stores the payload directly on the review_artifacts metadata JSON. */
  public async putJson(
    input: StoreJsonReviewArtifactPayloadInput,
  ): Promise<ReviewArtifactPayloadRecord> {
    const bytes = serializeReviewArtifactJsonPayload(input.payload);
    const descriptor = {
      hash: sha256(bytes),
      mediaType: REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
      mode: INLINE_REVIEW_ARTIFACT_STORAGE_MODE,
      sizeBytes: bytes.byteLength,
      uri: input.uri ?? reviewArtifactDatabaseUri(input),
    } satisfies ReviewArtifactPayloadDescriptor;

    return {
      ...descriptor,
      metadata: {
        ...input.metadata,
        [REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY]: descriptor,
        [REVIEW_ARTIFACT_INLINE_PAYLOAD_METADATA_KEY]: input.payload,
      },
    };
  }

  /** Reads legacy inline payloads from review_artifacts metadata. */
  public async getJson(
    input: ReadJsonReviewArtifactPayloadInput,
  ): Promise<ReadJsonReviewArtifactPayloadResult> {
    return readInlineReviewArtifactPayload(input.metadata);
  }

  /** Reports whether inline payload metadata exists so callers can scrub the DB row. */
  public async deleteJson(
    input: DeleteJsonReviewArtifactPayloadInput,
  ): Promise<DeleteJsonReviewArtifactPayloadResult> {
    return { deleted: readInlineReviewArtifactPayload(input.metadata).exists };
  }
}

/** Filesystem-backed JSON payload store for local dev or shared-volume deployments. */
export class FileSystemReviewArtifactPayloadStore implements ReviewArtifactPayloadStore {
  /** Absolute root directory that owns all artifact payload files. */
  private readonly rootDir: string;

  /** Creates a filesystem-backed payload store. */
  public constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  /** Stores the payload as a JSON file and persists only a descriptor in DB metadata. */
  public async putJson(
    input: StoreJsonReviewArtifactPayloadInput,
  ): Promise<ReviewArtifactPayloadRecord> {
    const bytes = serializeReviewArtifactJsonPayload(input.payload);
    const hash = sha256(bytes);
    const payloadPath = reviewArtifactPayloadPath(this.rootDir, input, hash);
    await mkdir(dirname(payloadPath), { recursive: true });
    await writeFile(payloadPath, bytes);

    const descriptor = {
      hash,
      mediaType: REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
      mode: FILE_SYSTEM_REVIEW_ARTIFACT_STORAGE_MODE,
      sizeBytes: bytes.byteLength,
      uri: pathToFileURL(payloadPath).toString(),
    } satisfies ReviewArtifactPayloadDescriptor;

    return {
      ...descriptor,
      metadata: {
        ...input.metadata,
        [REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY]: descriptor,
      },
    };
  }

  /** Reads a JSON payload from a file URI when the file remains inside the configured root. */
  public async getJson(
    input: ReadJsonReviewArtifactPayloadInput,
  ): Promise<ReadJsonReviewArtifactPayloadResult> {
    const payloadPath = payloadPathFromFileUri(input.uri);
    if (!payloadPath || !isPathInsideRoot(this.rootDir, payloadPath)) {
      return { exists: false };
    }

    try {
      const bytes = await readFile(payloadPath);
      const descriptor = reviewArtifactPayloadDescriptorFromMetadata(input.metadata);
      if (descriptor && descriptor.hash !== sha256(bytes)) {
        throw new Error("Review artifact payload hash mismatch.");
      }

      return { exists: true, payload: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { exists: false };
      }

      throw error;
    }
  }

  /** Deletes a filesystem-backed payload only when it remains inside the configured root. */
  public async deleteJson(
    input: DeleteJsonReviewArtifactPayloadInput,
  ): Promise<DeleteJsonReviewArtifactPayloadResult> {
    const payloadPath = payloadPathFromFileUri(input.uri);
    if (!payloadPath || !isPathInsideRoot(this.rootDir, payloadPath)) {
      return { deleted: false };
    }

    try {
      await rm(payloadPath, { force: false });
      return { deleted: true };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { deleted: false };
      }

      throw error;
    }
  }
}

/** S3/R2-compatible JSON payload store backed by AWS Signature Version 4 requests. */
export class S3CompatibleReviewArtifactPayloadStore implements ReviewArtifactPayloadStore {
  /** S3-compatible bucket that owns artifact payloads. */
  private readonly bucket: string;
  /** AWS-compatible signing region. */
  private readonly region: string;
  /** SigV4 access key ID. */
  private readonly accessKeyId: string;
  /** SigV4 secret access key. */
  private readonly secretAccessKey: string;
  /** Optional temporary credential session token. */
  private readonly sessionToken: string | undefined;
  /** S3-compatible endpoint base URL. */
  private readonly endpoint: string | undefined;
  /** Optional key prefix within the bucket. */
  private readonly keyPrefix: string | undefined;
  /** Whether path-style addressing is used. */
  private readonly forcePathStyle: boolean;
  /** Fetch implementation used for object requests. */
  private readonly fetch: ReviewArtifactFetch;
  /** Clock used for SigV4 timestamps. */
  private readonly now: () => Date;

  /** Creates an S3-compatible artifact payload store. */
  public constructor(options: S3CompatibleReviewArtifactPayloadStoreOptions) {
    this.bucket = options.bucket;
    this.region = options.region;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.sessionToken = options.sessionToken;
    this.endpoint = options.endpoint;
    this.keyPrefix = options.keyPrefix;
    this.forcePathStyle = options.forcePathStyle ?? Boolean(options.endpoint);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
  }

  /** Stores the payload as an S3-compatible object and persists only descriptor metadata. */
  public async putJson(
    input: StoreJsonReviewArtifactPayloadInput,
  ): Promise<ReviewArtifactPayloadRecord> {
    const bytes = serializeReviewArtifactJsonPayload(input.payload);
    const hash = sha256(bytes);
    const key = reviewArtifactObjectKey(input, hash, this.keyPrefix);
    const url = this.objectUrl(key);
    const descriptor = {
      hash,
      mediaType: REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
      mode: OBJECT_REVIEW_ARTIFACT_STORAGE_MODE,
      sizeBytes: bytes.byteLength,
      uri: `s3://${this.bucket}/${key}`,
    } satisfies ReviewArtifactPayloadDescriptor;
    const headers = this.signHeaders({
      contentHash: hash,
      contentType: REVIEW_ARTIFACT_JSON_MEDIA_TYPE,
      method: "PUT",
      url,
    });
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const response = await this.fetch(url, { body, headers, method: "PUT" });
    if (!response.ok) {
      throw new Error(`Object storage artifact write failed with HTTP ${response.status}.`);
    }

    return {
      ...descriptor,
      metadata: {
        ...input.metadata,
        [REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY]: descriptor,
      },
    };
  }

  /** Reads a JSON payload from S3-compatible object storage. */
  public async getJson(
    input: ReadJsonReviewArtifactPayloadInput,
  ): Promise<ReadJsonReviewArtifactPayloadResult> {
    const parsed = parseS3ArtifactUri(input.uri);
    if (!parsed || parsed.bucket !== this.bucket) {
      return { exists: false };
    }

    const url = this.objectUrl(parsed.key);
    const headers = this.signHeaders({
      contentHash: SHA256_EMPTY_PAYLOAD,
      method: "GET",
      url,
    });
    const response = await this.fetch(url, { headers, method: "GET" });
    if (response.status === 404) {
      return { exists: false };
    }
    if (!response.ok) {
      throw new Error(`Object storage artifact read failed with HTTP ${response.status}.`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const descriptor = reviewArtifactPayloadDescriptorFromMetadata(input.metadata);
    if (descriptor && descriptor.hash !== sha256(bytes)) {
      throw new Error("Review artifact payload hash mismatch.");
    }

    return { exists: true, payload: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  }

  /** Deletes a JSON payload from S3-compatible object storage. */
  public async deleteJson(
    input: DeleteJsonReviewArtifactPayloadInput,
  ): Promise<DeleteJsonReviewArtifactPayloadResult> {
    const parsed = parseS3ArtifactUri(input.uri);
    if (!parsed || parsed.bucket !== this.bucket) {
      return { deleted: false };
    }

    const url = this.objectUrl(parsed.key);
    const response = await this.fetch(url, {
      headers: this.signHeaders({
        contentHash: SHA256_EMPTY_PAYLOAD,
        method: "DELETE",
        url,
      }),
      method: "DELETE",
    });
    if (response.status === 404) {
      return { deleted: false };
    }
    if (!response.ok) {
      throw new Error(`Object storage artifact delete failed with HTTP ${response.status}.`);
    }

    return { deleted: true };
  }

  /** Creates a short-lived signed GET URL for an S3-compatible object. */
  public async createSignedGetUrl(
    input: CreateSignedReviewArtifactPayloadUrlInput,
  ): Promise<CreateSignedReviewArtifactPayloadUrlResult> {
    const parsed = parseS3ArtifactUri(input.uri);
    if (!parsed || parsed.bucket !== this.bucket) {
      return { exists: false };
    }

    const now = this.now();
    const expiresInSeconds = normalizePresignedUrlExpires(input.expiresInSeconds);
    const signedUrl = presignS3GetUrl({
      accessKeyId: this.accessKeyId,
      expiresInSeconds,
      now,
      region: this.region,
      secretAccessKey: this.secretAccessKey,
      url: this.objectUrl(parsed.key),
      ...(input.responseContentDisposition
        ? { responseContentDisposition: input.responseContentDisposition }
        : {}),
      ...(input.responseContentType ? { responseContentType: input.responseContentType } : {}),
      ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
    });

    return {
      exists: true,
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
      url: signedUrl.toString(),
    };
  }

  /** Builds a signed S3-compatible object URL for a key. */
  private objectUrl(key: string): URL {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    if (!this.endpoint) {
      return new URL(`https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodedKey}`);
    }

    const endpoint = new URL(this.endpoint);
    const basePath = endpoint.pathname.replace(/\/+$/, "");
    if (this.forcePathStyle) {
      endpoint.pathname = `${basePath}/${encodeURIComponent(this.bucket)}/${encodedKey}`;
      return endpoint;
    }

    endpoint.hostname = `${this.bucket}.${endpoint.hostname}`;
    endpoint.pathname = `${basePath}/${encodedKey}`;
    return endpoint;
  }

  /** Returns SigV4-signed request headers for one object operation. */
  private signHeaders(input: {
    /** HTTP method. */
    readonly method: "DELETE" | "GET" | "PUT";
    /** Request URL. */
    readonly url: URL;
    /** SHA-256 hash for the request payload. */
    readonly contentHash: `sha256:${string}`;
    /** Optional content type for requests with a body. */
    readonly contentType?: string;
  }): Record<string, string> {
    return signS3Request({
      accessKeyId: this.accessKeyId,
      contentHash: input.contentHash,
      method: input.method,
      now: this.now(),
      region: this.region,
      secretAccessKey: this.secretAccessKey,
      url: input.url,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
    });
  }
}

/** Creates the configured artifact payload store from environment variables. */
export function createReviewArtifactPayloadStoreFromEnvironment(
  env: ReviewArtifactPayloadStoreEnvironment,
): ReviewArtifactPayloadStore {
  const root = env.HEIMDALL_REVIEW_ARTIFACT_ROOT;
  if (root && root.trim().length > 0) {
    return new FileSystemReviewArtifactPayloadStore(root);
  }

  const bucket = env.HEIMDALL_REVIEW_ARTIFACT_BUCKET ?? env.OBJECT_STORAGE_BUCKET;
  const accessKeyId = env.HEIMDALL_REVIEW_ARTIFACT_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    env.HEIMDALL_REVIEW_ARTIFACT_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY;
  if (bucket && accessKeyId && secretAccessKey) {
    const forcePathStyle = booleanEnv(env.HEIMDALL_REVIEW_ARTIFACT_FORCE_PATH_STYLE);
    const sessionToken = env.HEIMDALL_REVIEW_ARTIFACT_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN;

    return new S3CompatibleReviewArtifactPayloadStore({
      accessKeyId,
      bucket,
      region:
        env.HEIMDALL_REVIEW_ARTIFACT_REGION ??
        env.AWS_REGION ??
        env.AWS_DEFAULT_REGION ??
        "us-east-1",
      secretAccessKey,
      ...(env.HEIMDALL_REVIEW_ARTIFACT_ENDPOINT
        ? { endpoint: env.HEIMDALL_REVIEW_ARTIFACT_ENDPOINT }
        : {}),
      ...(forcePathStyle === undefined ? {} : { forcePathStyle }),
      ...(env.HEIMDALL_REVIEW_ARTIFACT_KEY_PREFIX
        ? { keyPrefix: env.HEIMDALL_REVIEW_ARTIFACT_KEY_PREFIX }
        : {}),
      ...(sessionToken ? { sessionToken } : {}),
    });
  }

  return new InlineReviewArtifactPayloadStore();
}

/** Returns a payload descriptor without DB metadata or inline payload values. */
export function reviewArtifactPayloadDescriptor(
  record: ReviewArtifactPayloadRecord,
): ReviewArtifactPayloadDescriptor {
  return {
    hash: record.hash,
    mediaType: record.mediaType,
    mode: record.mode,
    sizeBytes: record.sizeBytes,
    uri: record.uri,
  };
}

/** Returns the database fallback URI for a review artifact payload. */
export function reviewArtifactDatabaseUri(input: {
  /** Review run that owns the artifact. */
  readonly reviewRunId: string;
  /** Artifact kind. */
  readonly kind: string;
  /** Human-readable artifact name scoped to the review run and kind. */
  readonly name: string;
}): string {
  return `${REVIEW_ARTIFACT_DATABASE_URI_PREFIX}${input.reviewRunId}/${input.kind}/${input.name}`;
}

/** Serializes a JSON review artifact payload into UTF-8 bytes. */
export function serializeReviewArtifactJsonPayload(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload) ?? "null");
}

/** Returns whether metadata references a readable artifact payload. */
export function hasReviewArtifactPayloadStorage(metadata: unknown): boolean {
  const record = asRecord(metadata);
  if (!record) {
    return false;
  }

  if (Object.hasOwn(record, REVIEW_ARTIFACT_INLINE_PAYLOAD_METADATA_KEY)) {
    return true;
  }

  return isReviewArtifactPayloadDescriptor(record[REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY]);
}

/** Returns metadata with payload bytes removed and a deletion tombstone added. */
export function reviewArtifactPayloadDeletedMetadata(input: {
  /** Metadata from the review_artifacts row before cleanup. */
  readonly metadata: unknown;
  /** ISO timestamp when cleanup removed the payload. */
  readonly deletedAt: string;
  /** Product-safe cleanup reason. */
  readonly reason: string;
}): Record<string, unknown> {
  const metadata = { ...(asRecord(input.metadata) ?? {}) };
  delete metadata[REVIEW_ARTIFACT_INLINE_PAYLOAD_METADATA_KEY];
  delete metadata[REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY];

  return {
    ...metadata,
    [REVIEW_ARTIFACT_PAYLOAD_DELETION_METADATA_KEY]: {
      deletedAt: input.deletedAt,
      reason: input.reason,
    },
  };
}

/** Reads an inline JSON payload from review artifact metadata. */
export function readInlineReviewArtifactPayload(
  metadata: unknown,
): ReadJsonReviewArtifactPayloadResult {
  const record = asRecord(metadata);
  if (!record || !Object.hasOwn(record, REVIEW_ARTIFACT_INLINE_PAYLOAD_METADATA_KEY)) {
    return { exists: false };
  }

  return { exists: true, payload: record[REVIEW_ARTIFACT_INLINE_PAYLOAD_METADATA_KEY] };
}

/** Returns whether a value is a review artifact payload descriptor. */
export function isReviewArtifactPayloadDescriptor(
  value: unknown,
): value is ReviewArtifactPayloadDescriptor {
  const record = asRecord(value);
  if (!record) {
    return false;
  }

  return (
    (record.mode === INLINE_REVIEW_ARTIFACT_STORAGE_MODE ||
      record.mode === OBJECT_REVIEW_ARTIFACT_STORAGE_MODE ||
      record.mode === FILE_SYSTEM_REVIEW_ARTIFACT_STORAGE_MODE) &&
    typeof record.uri === "string" &&
    record.uri.length > 0 &&
    typeof record.hash === "string" &&
    record.hash.startsWith("sha256:") &&
    typeof record.sizeBytes === "number" &&
    Number.isSafeInteger(record.sizeBytes) &&
    record.sizeBytes >= 0 &&
    typeof record.mediaType === "string" &&
    record.mediaType.length > 0
  );
}

/** Reads a payload storage descriptor from artifact metadata. */
function reviewArtifactPayloadDescriptorFromMetadata(
  metadata: unknown,
): ReviewArtifactPayloadDescriptor | undefined {
  const record = asRecord(metadata);
  const descriptor = record?.[REVIEW_ARTIFACT_PAYLOAD_STORAGE_METADATA_KEY];

  return isReviewArtifactPayloadDescriptor(descriptor) ? descriptor : undefined;
}

/** Returns the filesystem path used for a stored review artifact payload. */
function reviewArtifactPayloadPath(
  rootDir: string,
  input: StoreJsonReviewArtifactPayloadInput,
  hash: `sha256:${string}`,
): string {
  return join(
    rootDir,
    safeArtifactPathSegment(input.reviewRunId),
    safeArtifactPathSegment(input.kind),
    `${safeArtifactPathSegment(input.name)}-${hash.slice("sha256:".length, 19)}.json`,
  );
}

/** Returns the object key used for an S3-compatible review artifact payload. */
function reviewArtifactObjectKey(
  input: StoreJsonReviewArtifactPayloadInput,
  hash: `sha256:${string}`,
  keyPrefix?: string,
): string {
  const segments = [
    ...keyPrefixSegments(keyPrefix),
    safeArtifactPathSegment(input.reviewRunId),
    safeArtifactPathSegment(input.kind),
    `${safeArtifactPathSegment(input.name)}-${hash.slice("sha256:".length, 19)}.json`,
  ];

  return segments.join("/");
}

/** Parses an s3://bucket/key artifact URI. */
function parseS3ArtifactUri(
  uri: string,
): { readonly bucket: string; readonly key: string } | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "s3:" || parsed.hostname.length === 0) {
      return undefined;
    }

    const key = parsed.pathname.replace(/^\/+/, "");
    return key ? { bucket: parsed.hostname, key } : undefined;
  } catch {
    return undefined;
  }
}

/** Splits an optional object key prefix into safe path segments. */
function keyPrefixSegments(prefix: string | undefined): readonly string[] {
  if (!prefix || prefix.trim().length === 0) {
    return [];
  }

  return prefix
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map(safeArtifactPathSegment);
}

/** Converts a file URI to a path, returning undefined for unsupported URIs. */
function payloadPathFromFileUri(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "file:" ? fileURLToPath(parsed) : undefined;
  } catch {
    return undefined;
  }
}

/** Returns whether a path is within the configured artifact root. */
function isPathInsideRoot(rootDir: string, path: string): boolean {
  const relativePath = relative(rootDir, resolve(path));

  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/** Converts an artifact path segment to a conservative filesystem name. */
function safeArtifactPathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+$/, "artifact");
}

/** Returns whether an unknown error is a missing file read error. */
function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

/** Creates one S3-compatible presigned GET URL with AWS Signature Version 4. */
function presignS3GetUrl(input: {
  /** SigV4 access key ID. */
  readonly accessKeyId: string;
  /** SigV4 secret access key. */
  readonly secretAccessKey: string;
  /** Optional temporary credential session token. */
  readonly sessionToken?: string;
  /** AWS-compatible region. */
  readonly region: string;
  /** Request URL before presigned query parameters are added. */
  readonly url: URL;
  /** Request timestamp. */
  readonly now: Date;
  /** URL lifetime in seconds. */
  readonly expiresInSeconds: number;
  /** Optional response content disposition override. */
  readonly responseContentDisposition?: string;
  /** Optional response content type override. */
  readonly responseContentType?: string;
}): URL {
  const amzDate = sigV4Timestamp(input.now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const url = new URL(input.url);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${input.accessKeyId}/${credentialScope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", input.expiresInSeconds.toString());
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  if (input.sessionToken) {
    url.searchParams.set("X-Amz-Security-Token", input.sessionToken);
  }
  if (input.responseContentDisposition) {
    url.searchParams.set("response-content-disposition", input.responseContentDisposition);
  }
  if (input.responseContentType) {
    url.searchParams.set("response-content-type", input.responseContentType);
  }

  const canonical = canonicalS3Request({
    headers: {},
    method: "GET",
    payloadHash: S3_UNSIGNED_PAYLOAD,
    url,
  });
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonical.canonicalRequest),
  ].join("\n");
  const signature = hex(
    sigV4SignatureKey(input.secretAccessKey, dateStamp, input.region, stringToSign),
  );
  url.searchParams.set("X-Amz-Signature", signature);

  return url;
}

/** Signs one S3-compatible object storage request with AWS Signature Version 4. */
function signS3Request(input: {
  /** SigV4 access key ID. */
  readonly accessKeyId: string;
  /** SigV4 secret access key. */
  readonly secretAccessKey: string;
  /** Optional temporary credential session token. */
  readonly sessionToken?: string;
  /** AWS-compatible region. */
  readonly region: string;
  /** HTTP method. */
  readonly method: "DELETE" | "GET" | "PUT";
  /** Request URL. */
  readonly url: URL;
  /** Request timestamp. */
  readonly now: Date;
  /** SHA-256 hash for the request payload. */
  readonly contentHash: `sha256:${string}`;
  /** Optional content type for requests with a body. */
  readonly contentType?: string;
}): Record<string, string> {
  const amzDate = sigV4Timestamp(input.now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = input.contentHash.slice("sha256:".length);
  const headers: Record<string, string> = {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(input.contentType ? { "content-type": input.contentType } : {}),
    ...(input.sessionToken ? { "x-amz-security-token": input.sessionToken } : {}),
  };
  const canonical = canonicalS3Request({
    headers,
    method: input.method,
    payloadHash,
    url: input.url,
  });
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonical.canonicalRequest),
  ].join("\n");
  const signature = hex(
    sigV4SignatureKey(input.secretAccessKey, dateStamp, input.region, stringToSign),
  );

  return {
    ...headers,
    authorization: [
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}`,
      `SignedHeaders=${canonical.signedHeaders}`,
      `Signature=${signature}`,
    ].join(", "),
  };
}

/** Returns a bounded S3-compatible presigned URL lifetime. */
function normalizePresignedUrlExpires(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 300;
  }

  return Math.max(1, Math.min(Math.floor(value), MAX_S3_PRESIGNED_URL_EXPIRES_SECONDS));
}

/** Builds a canonical request string and signed header list for SigV4. */
function canonicalS3Request(input: {
  /** HTTP method. */
  readonly method: "DELETE" | "GET" | "PUT";
  /** Request URL. */
  readonly url: URL;
  /** Request headers other than host. */
  readonly headers: Record<string, string>;
  /** Hex SHA-256 payload hash. */
  readonly payloadHash: string;
}): { readonly canonicalRequest: string; readonly signedHeaders: string } {
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value.trim()]),
    ),
    host: input.url.host,
  };
  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${headers[name]?.replace(/\s+/g, " ") ?? ""}`)
    .join("\n");

  return {
    canonicalRequest: [
      input.method,
      canonicalUri(input.url.pathname),
      canonicalQuery(input.url.searchParams),
      `${canonicalHeaders}\n`,
      sortedHeaderNames.join(";"),
      input.payloadHash,
    ].join("\n"),
    signedHeaders: sortedHeaderNames.join(";"),
  };
}

/** Returns a SigV4 canonical URI from a URL pathname. */
function canonicalUri(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
    .join("/");
}

/** Returns a SigV4 canonical query string. */
function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/** Returns a SigV4 timestamp in basic ISO-8601 format. */
function sigV4Timestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** Parses an environment boolean where undefined means caller default. */
function booleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value === "true" || value === "1";
}

/** Returns a SHA-256 hash for serialized artifact bytes. */
function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Returns a hex SHA-256 hash without the schema prefix. */
function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Returns a SigV4 request signature key applied to a string-to-sign value. */
function sigV4SignatureKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  stringToSign: string,
): Uint8Array {
  return hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${secretAccessKey}`, dateStamp), region), "s3"),
    "aws4_request",
    stringToSign,
  );
}

/** Returns HMAC-SHA256 bytes for a string or bytes key. */
function hmacSha256(key: string | Uint8Array, data: string): Uint8Array;

/** Returns HMAC-SHA256 bytes for a derived bytes key and final data. */
function hmacSha256(key: Uint8Array, data: string, finalData: string): Uint8Array;

/** Returns HMAC-SHA256 bytes. */
function hmacSha256(key: string | Uint8Array, data: string, finalData?: string): Uint8Array {
  const derivedKey = createHmac("sha256", key).update(data).digest();
  return finalData === undefined
    ? new Uint8Array(derivedKey)
    : new Uint8Array(createHmac("sha256", derivedKey).update(finalData).digest());
}

/** Returns lowercase hex for bytes. */
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Narrows unknown metadata to a string-keyed object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
