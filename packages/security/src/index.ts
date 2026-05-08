import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Admin control-plane permissions enforced by API routes. */
export const ADMIN_PERMISSIONS = [
  "admin.inspect",
  "admin.replay.plan",
  "admin.replay.execute",
  "admin.settings.manage",
  "admin.audit.view",
] as const;

/** One granular admin control-plane permission. */
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/** Product organization roles used by customer-facing authorization. */
export const PRODUCT_ROLES = ["owner", "admin", "member", "viewer"] as const;

/** One product organization role. */
export type ProductRole = (typeof PRODUCT_ROLES)[number];

/** Product permissions enforced by customer-facing API routes. */
export const PRODUCT_PERMISSIONS = [
  "org:view",
  "org:manage",
  "org:members:read",
  "org:members:write",
  "installation:read",
  "installation:sync",
  "repo:read",
  "repo:settings:write",
  "repo:enable",
  "repo:disable",
  "repo:reindex",
  "review:read",
  "review:debug:read",
  "review:rerun",
  "finding:read",
  "finding:write",
  "rule:read",
  "rule:write",
  "memory:read",
  "memory:write",
  "usage:read",
  "audit:read",
  "billing:manage",
  "security:manage",
] as const;

/** One product permission. */
export type ProductPermission = (typeof PRODUCT_PERMISSIONS)[number];

/** Product organization membership attached to an authenticated user. */
export type ProductMembership = {
  /** Organization that granted the role. */
  readonly orgId: string;
  /** Role granted in the organization. */
  readonly role: ProductRole;
};

/** Authenticated product actor used by customer-facing API authorization. */
export type ProductActor = {
  /** Stable product user ID. */
  readonly userId: string;
  /** Organization memberships loaded from the database. */
  readonly memberships: readonly ProductMembership[];
  /** Optional dashboard convenience selection. */
  readonly selectedOrgId?: string | undefined;
};

/** Data classes used for artifacts, logs, audit events, and retention policy. */
export const DATA_CLASSIFICATIONS = [
  "public",
  "internal",
  "customer_confidential",
  "customer_code",
  "secret",
  "regulated_personal_data",
] as const;

/** Data class used for artifacts, logs, audit events, and retention policy. */
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

/** Retention classes used by security and artifact lifecycle policy. */
export const RETENTION_CLASSES = [
  "operational_short",
  "review_artifact",
  "index_lifetime",
  "audit",
  "billing",
  "security",
  "customer_configurable",
] as const;

/** Retention class used by security and artifact lifecycle policy. */
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Value tagged with a security data classification. */
export type ClassifiedValue<TValue> = {
  /** Classified value. */
  readonly value: TValue;
  /** Classification assigned to the value. */
  readonly classification: DataClassification;
  /** Product-safe reason for the classification. */
  readonly reason: string;
};

/** Input used to classify an artifact or artifact-like payload. */
export type ClassifyArtifactInput = {
  /** Artifact kind, such as raw_diff, context_bundle, or prompt_artifact. */
  readonly artifactType: string;
  /** Whether the artifact includes source code, diffs, snippets, or embeddings. */
  readonly containsCode?: boolean | undefined;
  /** Whether the artifact includes prompt text or prompt-derived content. */
  readonly containsPrompt?: boolean | undefined;
  /** Whether the artifact includes known or suspected credentials. */
  readonly containsToken?: boolean | undefined;
  /** Whether the artifact includes personal data such as names, emails, or profile data. */
  readonly containsPersonalData?: boolean | undefined;
};

/** Security metadata required for stored artifacts. */
export type ArtifactSecurityMetadata = {
  /** Stable artifact ID. */
  readonly artifactId: string;
  /** Organization that owns the artifact. */
  readonly orgId: string;
  /** Optional repository that owns the artifact. */
  readonly repoId?: string | undefined;
  /** Optional review run that created the artifact. */
  readonly reviewRunId?: string | undefined;
  /** Data classification assigned to the artifact. */
  readonly classification: DataClassification;
  /** Whether the artifact contains source code, diffs, snippets, prompts, or embeddings. */
  readonly containsCode: boolean;
  /** Whether the artifact contains known or suspected credentials. */
  readonly containsSecrets: boolean;
  /** Retention class applied to the artifact. */
  readonly retentionClass: RetentionClass;
  /** ISO timestamp for artifact creation. */
  readonly createdAt: string;
  /** Optional ISO timestamp when the artifact expires. */
  readonly expiresAt?: string | undefined;
  /** SHA-256 hash of the stored payload. */
  readonly sha256: string;
  /** Stored payload size in bytes. */
  readonly sizeBytes: number;
};

/** Organization retention policy controls. */
export type RetentionPolicy = {
  /** Organization that owns the policy. */
  readonly orgId: string;
  /** Retention window for raw diff artifacts. */
  readonly rawDiffDays: number;
  /** Retention window for retrieved context bundles. */
  readonly contextBundleDays: number;
  /** Retention window for prompt artifacts, or disabled to block storage. */
  readonly promptArtifactDays: number | "disabled";
  /** Retention window for generic review artifacts. */
  readonly reviewArtifactDays: number;
  /** Retention window for sandbox/static-analysis artifacts. */
  readonly sandboxArtifactDays: number;
  /** Retention behavior for index-derived artifacts. */
  readonly indexRetention: "while_enabled" | "fixed_days";
  /** Retention window for fixed-day index artifacts. */
  readonly indexArtifactDays: number;
  /** Retention window for operational short-lived records. */
  readonly operationalShortDays: number;
  /** Retention window for audit logs. */
  readonly auditLogDays: number;
  /** Retention window for billing/accounting records. */
  readonly billingUsageDays: number;
  /** Retention window for security events. */
  readonly securityEventDays: number;
  /** Whether repo disable should delete sensitive repo artifacts. */
  readonly deleteOnRepoDisable: boolean;
  /** Whether uninstall deletes immediately or after a grace period. */
  readonly deleteOnUninstall: "immediate" | "after_grace_period";
};

/** Retention decision for a stored artifact. */
export type RetentionDecision = {
  /** Retention class selected for the artifact. */
  readonly retentionClass: RetentionClass;
  /** Whether the artifact should be stored. */
  readonly storage: "allowed" | "disabled";
  /** Optional ISO expiration timestamp. */
  readonly expiresAt?: string | undefined;
  /** Whether repo disable should delete this artifact under the policy. */
  readonly deleteOnRepoDisable: boolean;
  /** Whether uninstall deletes this artifact immediately or after a grace period. */
  readonly deleteOnUninstall: "immediate" | "after_grace_period";
  /** Product-safe decision reason. */
  readonly reason: string;
};

/** Providers that can back a secret reference. */
export const SECRET_REF_PROVIDERS = [
  "env",
  "aws_secrets_manager",
  "gcp_secret_manager",
  "vault",
] as const;

/** Provider that can back a secret reference. */
export type SecretRefProvider = (typeof SECRET_REF_PROVIDERS)[number];

/** User-facing provider aliases accepted by secret ref parsing. */
const SECRET_REF_PROVIDER_ALIASES: Readonly<Record<string, SecretRefProvider>> = {
  aws: "aws_secrets_manager",
  aws_secrets_manager: "aws_secrets_manager",
  env: "env",
  gcp: "gcp_secret_manager",
  gcp_secret_manager: "gcp_secret_manager",
  vault: "vault",
};

/** Stable reference to a secret without embedding the secret value. */
export type SecretRef = {
  /** Secret storage provider. */
  readonly provider: SecretRefProvider;
  /** Provider-specific secret name or path. */
  readonly name: string;
  /** Optional provider-specific version identifier. */
  readonly version?: string | undefined;
};

/** Service identity resolving a secret value. */
export type SecretAccessService = "api" | "worker" | "admin_tools" | "llm_gateway" | "system";

/** Purpose for resolving a secret value. */
export type SecretAccessPurpose =
  | "github_app_private_key"
  | "github_webhook_secret"
  | "llm_provider_api_key"
  | "database_url"
  | "redis_url"
  | "object_storage_credential"
  | "session_signing_secret"
  | "encryption_key"
  | "customer_byok"
  | "other";

/** Reasons an operator or automation can rotate a secret. */
export const SECRET_ROTATION_REASONS = ["scheduled", "incident", "manual"] as const;

/** Reason an operator or automation rotated a secret. */
export type SecretRotationReason = (typeof SECRET_ROTATION_REASONS)[number];

/** Validation states for a secret rotation attempt. */
export const SECRET_ROTATION_VALIDATION_STATUSES = ["pending", "passed", "failed"] as const;

/** Validation state for a secret rotation attempt. */
export type SecretRotationValidationStatus = (typeof SECRET_ROTATION_VALIDATION_STATUSES)[number];

/** Product-safe record that tracks one secret rotation attempt. */
export type SecretRotationRecord = {
  /** Stable rotation record ID. */
  readonly id: string;
  /** Secret reference that was rotated. */
  readonly secretRef: SecretRef;
  /** ISO timestamp when rotation started. */
  readonly startedAt: string;
  /** ISO timestamp when rotation completed. */
  readonly completedAt?: string | undefined;
  /** Actor or automation identity that initiated rotation. */
  readonly initiatedBy: string;
  /** Reason rotation started. */
  readonly reason: SecretRotationReason;
  /** Previous provider-specific version when known. */
  readonly oldVersion?: string | undefined;
  /** New provider-specific version. */
  readonly newVersion: string;
  /** Validation status for the new version. */
  readonly validationStatus: SecretRotationValidationStatus;
};

/** Product-safe context attached to one secret resolution. */
export type SecretAccessContext = {
  /** Service identity resolving the secret. */
  readonly service?: SecretAccessService | undefined;
  /** Purpose for the secret resolution. */
  readonly purpose?: SecretAccessPurpose | undefined;
  /** Actor ID that caused the resolution when user initiated. */
  readonly actorId?: string | undefined;
  /** Request ID used for audit correlation. */
  readonly requestId?: string | undefined;
};

/** Secret value returned by a secrets manager. */
export type ResolvedSecret = {
  /** Secret reference that was resolved. */
  readonly ref: SecretRef;
  /** Secret value. Do not log this field. */
  readonly value: string;
  /** Provider-specific version that was resolved. */
  readonly version?: string | undefined;
  /** ISO timestamp when the value was resolved. */
  readonly resolvedAt: string;
};

/** Product-safe resolved secret representation for logs and audit metadata. */
export type RedactedResolvedSecret = Omit<ResolvedSecret, "value"> & {
  /** Redacted placeholder for the secret value. */
  readonly value: "[redacted-secret]";
};

/** Redaction modes used by logs, prompts, artifacts, and support views. */
export type RedactionMode = "logs" | "prompt" | "artifact" | "support_view";

/** Secret-like pattern categories recognized by the built-in redactor. */
export type RedactionMatchKind =
  | "aws_access_key_id"
  | "credential_url"
  | "github_token"
  | "jwt"
  | "literal_secret"
  | "openai_api_key"
  | "private_key"
  | "secret_assignment";

/** Options used when redacting text before logs, prompts, artifacts, or support views. */
export type RedactionOptions = {
  /** Caller context for the redaction operation. */
  readonly mode?: RedactionMode | undefined;
  /** Additional literal secret values to redact exactly when they are at least 8 characters. */
  readonly additionalSecrets?: readonly string[] | undefined;
};

/** Text returned by the redaction boundary with product-safe match metadata. */
export type RedactedString = {
  /** Redacted text value. */
  readonly value: string;
  /** Whether any replacement was applied. */
  readonly redacted: boolean;
  /** Number of replacements applied. */
  readonly replacementCount: number;
  /** Product-safe categories that matched. */
  readonly matchKinds: readonly RedactionMatchKind[];
};

/** Environment record used by secret-manager factories. */
export type SecretsManagerEnvironment = Readonly<Record<string, string | undefined>>;

/** Boundary used to resolve secrets from provider-specific storage. */
export type SecretsManager = {
  /** Resolves one secret reference for a service context. */
  readonly resolveSecret: (
    ref: SecretRef,
    context?: SecretAccessContext,
  ) => Promise<ResolvedSecret>;
};

/** Error codes returned by secret resolution boundaries. */
export type SecretResolutionErrorCode =
  | "secret_ref_invalid"
  | "secret_provider_error"
  | "secret_provider_unsupported"
  | "secret_not_found";

/** Error raised when a secret cannot be resolved safely. */
export class SecretResolutionError extends Error {
  /** Machine-readable failure code. */
  public readonly code: SecretResolutionErrorCode;

  /** Secret reference involved in the failure when available. */
  public readonly ref: SecretRef | undefined;

  /** Creates a secret resolution error. */
  public constructor(
    code: SecretResolutionErrorCode,
    message: string,
    ref?: SecretRef | undefined,
  ) {
    super(message);
    this.name = "SecretResolutionError";
    this.code = code;
    this.ref = ref;
  }
}

/** Options used to construct a local environment-backed secrets manager. */
export type LocalEnvSecretsManagerOptions = {
  /** Environment map used to look up secret names. Defaults to process.env. */
  readonly env?: SecretsManagerEnvironment | undefined;
  /** Current time provider used by tests. */
  readonly now?: (() => Date) | undefined;
};

/** Local development secrets manager that resolves `env:` secret references. */
export class LocalEnvSecretsManager implements SecretsManager {
  /** Environment map used to look up secret names. */
  private readonly env: SecretsManagerEnvironment;

  /** Current time provider. */
  private readonly now: () => Date;

  /** Creates a local environment-backed secrets manager. */
  public constructor(options: LocalEnvSecretsManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
  }

  /** Resolves an `env:` secret reference from the configured environment map. */
  public async resolveSecret(ref: SecretRef): Promise<ResolvedSecret> {
    assertValidSecretRef(ref);
    if (ref.provider !== "env") {
      throw new SecretResolutionError(
        "secret_provider_unsupported",
        `LocalEnvSecretsManager can only resolve env secret refs, not ${ref.provider}.`,
        ref,
      );
    }

    const value = this.env[ref.name];
    if (!value) {
      throw new SecretResolutionError(
        "secret_not_found",
        `Environment secret ${ref.name} was not set.`,
        ref,
      );
    }

    return {
      ref,
      resolvedAt: this.now().toISOString(),
      value,
      ...(ref.version ? { version: ref.version } : {}),
    };
  }
}

/** AWS credentials used by the AWS Secrets Manager adapter. */
export type AwsSecretsManagerCredentials = {
  /** AWS access key ID used for SigV4 signing. */
  readonly accessKeyId: string;
  /** AWS secret access key used for SigV4 signing. */
  readonly secretAccessKey: string;
  /** Optional AWS session token for temporary credentials. */
  readonly sessionToken?: string | undefined;
};

/** Minimal fetch response surface used by the AWS Secrets Manager adapter. */
export type AwsSecretsManagerFetchResponse = {
  /** Whether the HTTP status is in the successful range. */
  readonly ok: boolean;
  /** HTTP status code returned by AWS. */
  readonly status: number;
  /** Reads the response body as text. */
  readonly text: () => Promise<string>;
};

/** Minimal fetch function used by the AWS Secrets Manager adapter. */
export type AwsSecretsManagerFetch = (
  url: string,
  init: {
    /** Request body sent to AWS. */
    readonly body: string;
    /** Request headers sent to AWS. */
    readonly headers: Readonly<Record<string, string>>;
    /** HTTP method used for the request. */
    readonly method: "POST";
  },
) => Promise<AwsSecretsManagerFetchResponse>;

/** Options used to construct an AWS Secrets Manager adapter. */
export type AwsSecretsManagerOptions = {
  /** AWS credentials used for SigV4 signing. */
  readonly credentials: AwsSecretsManagerCredentials;
  /** Optional endpoint override for tests and private endpoints. */
  readonly endpoint?: string | undefined;
  /** Fetch implementation used for AWS requests. Defaults to global fetch. */
  readonly fetch?: AwsSecretsManagerFetch | undefined;
  /** Current time provider used for deterministic SigV4 tests. */
  readonly now?: (() => Date) | undefined;
  /** AWS region that hosts Secrets Manager. */
  readonly region: string;
};

/** Options used to construct an AWS adapter from environment variables. */
export type AwsSecretsManagerFromEnvironmentOptions = {
  /** Optional endpoint override for tests and private endpoints. */
  readonly endpoint?: string | undefined;
  /** Environment map used to read AWS configuration. Defaults to process.env. */
  readonly env?: SecretsManagerEnvironment | undefined;
  /** Fetch implementation used for AWS requests. Defaults to global fetch. */
  readonly fetch?: AwsSecretsManagerFetch | undefined;
  /** Current time provider used by tests. */
  readonly now?: (() => Date) | undefined;
};

/** Minimal fetch response surface used by the GCP Secret Manager adapter. */
export type GcpSecretManagerFetchResponse = {
  /** Whether the HTTP status is in the successful range. */
  readonly ok: boolean;
  /** HTTP status code returned by GCP. */
  readonly status: number;
  /** Reads the response body as text. */
  readonly text: () => Promise<string>;
};

/** Minimal fetch function used by the GCP Secret Manager adapter. */
export type GcpSecretManagerFetch = (
  url: string,
  init: {
    /** Request headers sent to GCP. */
    readonly headers: Readonly<Record<string, string>>;
    /** HTTP method used for the request. */
    readonly method: "GET";
  },
) => Promise<GcpSecretManagerFetchResponse>;

/** Options used to construct a GCP Secret Manager adapter. */
export type GcpSecretManagerOptions = {
  /** OAuth2 bearer token used to call GCP Secret Manager. */
  readonly accessToken: string;
  /** Optional endpoint override for tests and private endpoints. */
  readonly endpoint?: string | undefined;
  /** Fetch implementation used for GCP requests. Defaults to global fetch. */
  readonly fetch?: GcpSecretManagerFetch | undefined;
  /** Current time provider used by tests. */
  readonly now?: (() => Date) | undefined;
};

/** Options used to construct a GCP adapter from environment variables. */
export type GcpSecretManagerFromEnvironmentOptions = {
  /** Optional endpoint override for tests and private endpoints. */
  readonly endpoint?: string | undefined;
  /** Environment map used to read GCP configuration. Defaults to process.env. */
  readonly env?: SecretsManagerEnvironment | undefined;
  /** Fetch implementation used for GCP requests. Defaults to global fetch. */
  readonly fetch?: GcpSecretManagerFetch | undefined;
  /** Current time provider used by tests. */
  readonly now?: (() => Date) | undefined;
};

/** Options used to construct a provider-routing secrets manager from environment variables. */
export type SecretsManagerFromEnvironmentOptions = {
  /** Optional AWS endpoint override for tests and private endpoints. */
  readonly awsEndpoint?: string | undefined;
  /** Environment map used to read provider configuration. Defaults to process.env. */
  readonly env?: SecretsManagerEnvironment | undefined;
  /** Fetch implementation used for AWS requests. Defaults to global fetch. */
  readonly fetch?: AwsSecretsManagerFetch | undefined;
  /** Optional GCP endpoint override for tests and private endpoints. */
  readonly gcpEndpoint?: string | undefined;
  /** Fetch implementation used for GCP requests. Defaults to global fetch. */
  readonly gcpFetch?: GcpSecretManagerFetch | undefined;
  /** Current time provider used by tests. */
  readonly now?: (() => Date) | undefined;
};

/** AWS Secrets Manager adapter for production secret references. */
export class AwsSecretsManager implements SecretsManager {
  /** AWS credentials used for SigV4 signing. */
  private readonly credentials: AwsSecretsManagerCredentials;
  /** AWS Secrets Manager endpoint. */
  private readonly endpoint: string;
  /** Fetch implementation used for AWS requests. */
  private readonly fetch: AwsSecretsManagerFetch;
  /** Current time provider. */
  private readonly now: () => Date;
  /** AWS region that hosts Secrets Manager. */
  private readonly region: string;

  /** Creates an AWS Secrets Manager adapter. */
  public constructor(options: AwsSecretsManagerOptions) {
    const region = options.region.trim();
    const accessKeyId = options.credentials.accessKeyId.trim();
    const secretAccessKey = options.credentials.secretAccessKey.trim();
    if (!region || !accessKeyId || !secretAccessKey) {
      throw new SecretResolutionError(
        "secret_provider_error",
        "AWS Secrets Manager requires a non-empty region, access key ID, and secret access key.",
      );
    }

    this.credentials = {
      accessKeyId,
      secretAccessKey,
      ...(options.credentials.sessionToken?.trim()
        ? { sessionToken: options.credentials.sessionToken.trim() }
        : {}),
    };
    this.endpoint = options.endpoint ?? `https://secretsmanager.${region}.amazonaws.com/`;
    this.fetch = options.fetch ?? defaultAwsSecretsManagerFetch;
    this.now = options.now ?? (() => new Date());
    this.region = region;
  }

  /** Resolves an `aws_secrets_manager:` reference through AWS Secrets Manager. */
  public async resolveSecret(ref: SecretRef): Promise<ResolvedSecret> {
    assertValidSecretRef(ref);
    if (ref.provider !== "aws_secrets_manager") {
      throw new SecretResolutionError(
        "secret_provider_unsupported",
        `AwsSecretsManager can only resolve aws_secrets_manager secret refs, not ${ref.provider}.`,
        ref,
      );
    }

    const body = JSON.stringify({
      SecretId: ref.name,
      ...(ref.version ? { VersionId: ref.version } : {}),
    });
    const signedRequest = createAwsSecretsManagerSignedRequest({
      body,
      credentials: this.credentials,
      endpoint: this.endpoint,
      now: this.now(),
      region: this.region,
    });
    let response: AwsSecretsManagerFetchResponse;
    try {
      response = await this.fetch(this.endpoint, {
        body,
        headers: signedRequest.headers,
        method: "POST",
      });
    } catch (error) {
      if (error instanceof SecretResolutionError) {
        throw error;
      }
      throw new SecretResolutionError(
        "secret_provider_error",
        `AWS Secrets Manager request failed with ${safeErrorName(error)}.`,
        ref,
      );
    }
    const responseText = await response.text();
    if (!response.ok) {
      throw awsSecretResolutionError(response.status, responseText, ref);
    }

    const parsed = parseAwsGetSecretValueResponse(responseText, ref);
    return {
      ref,
      resolvedAt: this.now().toISOString(),
      value: parsed.value,
      ...(parsed.version ? { version: parsed.version } : {}),
    };
  }
}

/** GCP Secret Manager adapter for production secret references. */
export class GcpSecretManager implements SecretsManager {
  /** OAuth2 bearer token used to call GCP Secret Manager. */
  private readonly accessToken: string;
  /** GCP Secret Manager API endpoint. */
  private readonly endpoint: string;
  /** Fetch implementation used for provider requests. */
  private readonly fetch: GcpSecretManagerFetch;
  /** Current time provider. */
  private readonly now: () => Date;

  /** Creates a GCP Secret Manager adapter. */
  public constructor(options: GcpSecretManagerOptions) {
    const accessToken = options.accessToken.trim();
    if (!accessToken) {
      throw new SecretResolutionError(
        "secret_provider_error",
        "GCP Secret Manager requires a non-empty access token.",
      );
    }

    this.accessToken = accessToken;
    this.endpoint = options.endpoint ?? "https://secretmanager.googleapis.com/v1";
    this.fetch = options.fetch ?? defaultGcpSecretManagerFetch;
    this.now = options.now ?? (() => new Date());
  }

  /** Resolves a `gcp_secret_manager:` reference through GCP Secret Manager. */
  public async resolveSecret(ref: SecretRef): Promise<ResolvedSecret> {
    assertValidSecretRef(ref);
    if (ref.provider !== "gcp_secret_manager") {
      throw new SecretResolutionError(
        "secret_provider_unsupported",
        `GcpSecretManager can only resolve gcp_secret_manager secret refs, not ${ref.provider}.`,
        ref,
      );
    }

    const resourceName = gcpSecretVersionResourceName(ref);
    let response: GcpSecretManagerFetchResponse;
    try {
      response = await this.fetch(gcpSecretAccessUrl(this.endpoint, resourceName), {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.accessToken}`,
        },
        method: "GET",
      });
    } catch (error) {
      if (error instanceof SecretResolutionError) {
        throw error;
      }
      throw new SecretResolutionError(
        "secret_provider_error",
        `GCP Secret Manager request failed with ${safeErrorName(error)}.`,
        ref,
      );
    }
    const responseText = await response.text();
    if (!response.ok) {
      throw gcpSecretResolutionError(response.status, responseText, ref);
    }

    const parsed = parseGcpAccessSecretVersionResponse(responseText, ref);
    return {
      ref,
      resolvedAt: this.now().toISOString(),
      value: parsed.value,
      ...(parsed.version ? { version: parsed.version } : {}),
    };
  }
}

/** Secrets manager that routes refs to provider-specific managers. */
export class ProviderRoutingSecretsManager implements SecretsManager {
  /** Managers keyed by canonical secret ref provider. */
  private readonly managers: Readonly<Partial<Record<SecretRefProvider, SecretsManager>>>;

  /** Creates a provider-routing secrets manager. */
  public constructor(managers: Readonly<Partial<Record<SecretRefProvider, SecretsManager>>>) {
    this.managers = managers;
  }

  /** Resolves a secret through the manager registered for the ref provider. */
  public async resolveSecret(
    ref: SecretRef,
    context?: SecretAccessContext,
  ): Promise<ResolvedSecret> {
    const validated = assertValidSecretRef(ref);
    const manager = this.managers[validated.provider];
    if (!manager) {
      throw new SecretResolutionError(
        "secret_provider_unsupported",
        `Secret provider ${validated.provider} is not configured in this runtime.`,
        validated,
      );
    }

    return manager.resolveSecret(validated, context);
  }
}

/** Secrets manager placeholder for production providers that are not wired yet. */
export class UnsupportedProductionSecretsManager implements SecretsManager {
  /** Provider represented by this placeholder. */
  private readonly provider: Exclude<SecretRefProvider, "env">;

  /** Creates an unsupported production provider placeholder. */
  public constructor(provider: Exclude<SecretRefProvider, "env">) {
    this.provider = provider;
  }

  /** Rejects resolution until a concrete production provider is configured. */
  public async resolveSecret(ref: SecretRef): Promise<ResolvedSecret> {
    assertValidSecretRef(ref);
    throw new SecretResolutionError(
      "secret_provider_unsupported",
      `Secret provider ${this.provider} is not configured in this runtime.`,
      ref,
    );
  }
}

/** Creates a local environment-backed secrets manager. */
export function createLocalEnvSecretsManager(
  options: LocalEnvSecretsManagerOptions = {},
): SecretsManager {
  return new LocalEnvSecretsManager(options);
}

/** Creates an AWS Secrets Manager-backed secrets manager. */
export function createAwsSecretsManager(options: AwsSecretsManagerOptions): SecretsManager {
  return new AwsSecretsManager(options);
}

/** Creates a GCP Secret Manager-backed secrets manager. */
export function createGcpSecretManager(options: GcpSecretManagerOptions): SecretsManager {
  return new GcpSecretManager(options);
}

/** Creates an AWS Secrets Manager adapter when environment configuration is complete. */
export function createAwsSecretsManagerFromEnvironment(
  options: AwsSecretsManagerFromEnvironmentOptions = {},
): SecretsManager | undefined {
  const env = options.env ?? process.env;
  const region =
    optionalEnvironmentString(env.HEIMDALL_AWS_SECRETS_MANAGER_REGION) ??
    optionalEnvironmentString(env.AWS_SECRETS_MANAGER_REGION) ??
    optionalEnvironmentString(env.AWS_REGION) ??
    optionalEnvironmentString(env.AWS_DEFAULT_REGION);
  const accessKeyId = optionalEnvironmentString(env.AWS_ACCESS_KEY_ID);
  const secretAccessKey = optionalEnvironmentString(env.AWS_SECRET_ACCESS_KEY);
  if (!region || !accessKeyId || !secretAccessKey) {
    return undefined;
  }

  const endpoint =
    options.endpoint ??
    optionalEnvironmentString(env.HEIMDALL_AWS_SECRETS_MANAGER_ENDPOINT) ??
    optionalEnvironmentString(env.AWS_SECRETS_MANAGER_ENDPOINT);
  const sessionToken = optionalEnvironmentString(env.AWS_SESSION_TOKEN);
  return createAwsSecretsManager({
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    },
    ...(endpoint ? { endpoint } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    region,
  });
}

/** Creates a GCP Secret Manager adapter when environment configuration is complete. */
export function createGcpSecretManagerFromEnvironment(
  options: GcpSecretManagerFromEnvironmentOptions = {},
): SecretsManager | undefined {
  const env = options.env ?? process.env;
  const accessToken =
    optionalEnvironmentString(env.HEIMDALL_GCP_SECRET_MANAGER_ACCESS_TOKEN) ??
    optionalEnvironmentString(env.GCP_SECRET_MANAGER_ACCESS_TOKEN) ??
    optionalEnvironmentString(env.GOOGLE_OAUTH_ACCESS_TOKEN) ??
    optionalEnvironmentString(env.GOOGLE_ACCESS_TOKEN);
  if (!accessToken) {
    return undefined;
  }

  const endpoint =
    options.endpoint ??
    optionalEnvironmentString(env.HEIMDALL_GCP_SECRET_MANAGER_ENDPOINT) ??
    optionalEnvironmentString(env.GCP_SECRET_MANAGER_ENDPOINT);
  return createGcpSecretManager({
    accessToken,
    ...(endpoint ? { endpoint } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

/** Creates a provider-routing secrets manager from runtime environment variables. */
export function createSecretsManagerFromEnvironment(
  options: SecretsManagerFromEnvironmentOptions = {},
): SecretsManager {
  const env = options.env ?? process.env;
  const managers: Partial<Record<SecretRefProvider, SecretsManager>> = {
    env: createLocalEnvSecretsManager({
      env,
      ...(options.now ? { now: options.now } : {}),
    }),
  };
  const awsSecretsManager = createAwsSecretsManagerFromEnvironment({
    ...(options.awsEndpoint ? { endpoint: options.awsEndpoint } : {}),
    env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (awsSecretsManager) {
    managers.aws_secrets_manager = awsSecretsManager;
  }
  const gcpSecretsManager = createGcpSecretManagerFromEnvironment({
    env,
    ...(options.gcpEndpoint ? { endpoint: options.gcpEndpoint } : {}),
    ...(options.gcpFetch ? { fetch: options.gcpFetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (gcpSecretsManager) {
    managers.gcp_secret_manager = gcpSecretsManager;
  }

  return new ProviderRoutingSecretsManager(managers);
}

/** Creates a production provider placeholder that rejects resolution. */
export function createUnsupportedProductionSecretsManager(
  provider: Exclude<SecretRefProvider, "env">,
): SecretsManager {
  return new UnsupportedProductionSecretsManager(provider);
}

/** Parses a secret reference string into a structured reference. */
export function parseSecretRef(input: string): SecretRef {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new SecretResolutionError("secret_ref_invalid", "Secret ref must not be empty.");
  }

  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex === -1) {
    return assertValidSecretRef({ name: trimmed, provider: "env" });
  }

  const provider = secretProviderFromString(trimmed.slice(0, separatorIndex));
  if (!provider) {
    throw new SecretResolutionError(
      "secret_ref_invalid",
      `Secret ref provider ${trimmed.slice(0, separatorIndex)} is not supported.`,
    );
  }

  const nameAndVersion = trimmed.slice(separatorIndex + 1);
  const versionSeparatorIndex = nameAndVersion.lastIndexOf("#");
  const name =
    versionSeparatorIndex === -1
      ? nameAndVersion.trim()
      : nameAndVersion.slice(0, versionSeparatorIndex).trim();
  const version =
    versionSeparatorIndex === -1
      ? undefined
      : nameAndVersion.slice(versionSeparatorIndex + 1).trim();

  return assertValidSecretRef({
    name,
    provider,
    ...(version ? { version } : {}),
  });
}

/** Formats a structured secret reference using the canonical provider name. */
export function formatSecretRef(ref: SecretRef): string {
  const validated = assertValidSecretRef(ref);
  return `${validated.provider}:${validated.name}${validated.version ? `#${validated.version}` : ""}`;
}

/** Returns a product-safe label for a secret reference. */
export function secretRefLabel(ref: SecretRef): string {
  return formatSecretRef(ref);
}

/** Replaces a resolved secret value with a product-safe placeholder. */
export function redactResolvedSecret(secret: ResolvedSecret): RedactedResolvedSecret {
  return {
    ref: secret.ref,
    resolvedAt: secret.resolvedAt,
    value: "[redacted-secret]",
    ...(secret.version ? { version: secret.version } : {}),
  };
}

/** Redacts known secret patterns from text. */
export function redactString(input: string, options: RedactionOptions = {}): RedactedString {
  const matchedKinds = new Set<RedactionMatchKind>();
  let replacementCount = 0;
  let value = input;

  for (const literalSecret of uniqueLiteralSecrets(options.additionalSecrets ?? [])) {
    const occurrences = countLiteralOccurrences(value, literalSecret);
    if (occurrences > 0) {
      matchedKinds.add("literal_secret");
      replacementCount += occurrences;
      value = value.split(literalSecret).join("[redacted]");
    }
  }

  for (const pattern of SECRET_REDACTION_PATTERNS) {
    value = value.replace(pattern.pattern, (...args: unknown[]) => {
      replacementCount += 1;
      matchedKinds.add(pattern.kind);
      return typeof pattern.replacement === "function"
        ? pattern.replacement(args)
        : pattern.replacement;
    });
  }

  return {
    matchKinds: [...matchedKinds],
    redacted: replacementCount > 0,
    replacementCount,
    value,
  };
}

/** Redacts secret-like data from model prompts before provider calls. */
export function redactPromptSecrets(prompt: string): RedactedString {
  return redactString(prompt, { mode: "prompt" });
}

/** Validates a structured secret reference. */
export function assertValidSecretRef(ref: SecretRef): SecretRef {
  if (!SECRET_REF_PROVIDERS.includes(ref.provider)) {
    throw new SecretResolutionError(
      "secret_ref_invalid",
      `Secret ref provider ${String(ref.provider)} is not supported.`,
      ref,
    );
  }
  if (ref.name.trim().length === 0) {
    throw new SecretResolutionError(
      "secret_ref_invalid",
      "Secret ref name must not be empty.",
      ref,
    );
  }
  if (containsControlCharacter(ref.name) || containsControlCharacter(ref.version ?? "")) {
    throw new SecretResolutionError(
      "secret_ref_invalid",
      "Secret ref names and versions must not contain control characters.",
      ref,
    );
  }

  return {
    name: ref.name.trim(),
    provider: ref.provider,
    ...(ref.version?.trim() ? { version: ref.version.trim() } : {}),
  };
}

/** Severity levels used for security events and incident triage. */
export const SECURITY_EVENT_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

/** Severity level used for security events and incident triage. */
export type SecurityEventSeverity = (typeof SECURITY_EVENT_SEVERITIES)[number];

/** Sources that can emit security events. */
export const SECURITY_EVENT_SOURCES = [
  "api",
  "worker",
  "github",
  "sandbox",
  "llm_gateway",
  "system",
] as const;

/** Source that emitted one security event. */
export type SecurityEventSource = (typeof SECURITY_EVENT_SOURCES)[number];

/** Lifecycle states for security event triage. */
export const SECURITY_EVENT_STATUSES = ["new", "triaged", "dismissed", "incident_created"] as const;

/** Lifecycle state for security event triage. */
export type SecurityEventStatus = (typeof SECURITY_EVENT_STATUSES)[number];

/** Structured high-risk security event recorded by services and control-plane workflows. */
export type SecurityEvent = {
  /** Stable event ID. */
  readonly id: string;
  /** Organization scope when the event is tenant-specific. */
  readonly orgId?: string | undefined;
  /** Repository scope when the event is repository-specific. */
  readonly repoId?: string | undefined;
  /** Event type, such as invalid_webhook_signature_spike. */
  readonly type: string;
  /** Security severity for triage and alerting. */
  readonly severity: SecurityEventSeverity;
  /** Service or subsystem that emitted the event. */
  readonly source: SecurityEventSource;
  /** Actor that triggered the event when known. */
  readonly actorId?: string | undefined;
  /** Resource type affected by the event. */
  readonly resourceType?: string | undefined;
  /** Resource ID affected by the event. */
  readonly resourceId?: string | undefined;
  /** Product-safe metadata with sensitive keys and values removed or redacted. */
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  /** ISO timestamp when the event was created. */
  readonly createdAt: string;
  /** Triage status. */
  readonly status: SecurityEventStatus;
};

/** Input accepted when creating a normalized security event. */
export type SecurityEventInput = {
  /** Optional stable event ID. Defaults to a generated ID. */
  readonly id?: string | undefined;
  /** Organization scope when the event is tenant-specific. */
  readonly orgId?: string | undefined;
  /** Repository scope when the event is repository-specific. */
  readonly repoId?: string | undefined;
  /** Event type, such as invalid_webhook_signature_spike. */
  readonly type: string;
  /** Optional explicit severity. Defaults from the event type. */
  readonly severity?: SecurityEventSeverity | undefined;
  /** Service or subsystem that emitted the event. */
  readonly source: SecurityEventSource;
  /** Actor that triggered the event when known. */
  readonly actorId?: string | undefined;
  /** Resource type affected by the event. */
  readonly resourceType?: string | undefined;
  /** Resource ID affected by the event. */
  readonly resourceId?: string | undefined;
  /** Metadata that is sanitized before recording. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** Optional deterministic timestamp for tests. */
  readonly createdAt?: string | undefined;
  /** Triage status. Defaults to new. */
  readonly status?: SecurityEventStatus | undefined;
};

/** Sink that records normalized security events. */
export type SecurityEventSink = {
  /** Records one normalized security event. */
  readonly record: (event: SecurityEvent) => void;
};

/** In-memory security-event sink used by tests and local tools. */
export type MemorySecurityEventSink = SecurityEventSink & {
  /** Removes all recorded events. */
  readonly clear: () => void;
  /** Returns recorded events in insertion order. */
  readonly events: () => readonly SecurityEvent[];
};

/** Stable control IDs used when collecting security and compliance evidence. */
export const COMPLIANCE_CONTROL_IDS = [
  "soc2.cc6.1.access_review",
  "soc2.cc7.2.audit_logging",
  "soc2.cc8.1.change_management",
  "gdpr.art15.data_export",
  "gdpr.art17.data_deletion",
  "nist.ssdf.po.5.security_events",
] as const;

/** Stable control ID used when collecting security and compliance evidence. */
export type ComplianceControlId = (typeof COMPLIANCE_CONTROL_IDS)[number];

/** Evidence artifact types supported by the MVP compliance evidence boundary. */
export const COMPLIANCE_EVIDENCE_TYPES = [
  "access_review_export",
  "audit_log_export",
  "config_snapshot",
  "data_deletion_report",
  "security_event_export",
] as const;

/** Evidence artifact type supported by the MVP compliance evidence boundary. */
export type ComplianceEvidenceType = (typeof COMPLIANCE_EVIDENCE_TYPES)[number];

/** Lifecycle state for a collected compliance evidence record. */
export const COMPLIANCE_EVIDENCE_STATUSES = ["collected", "failed", "superseded"] as const;

/** Lifecycle state for a collected compliance evidence record. */
export type ComplianceEvidenceStatus = (typeof COMPLIANCE_EVIDENCE_STATUSES)[number];

/** Service or automation source that collected compliance evidence. */
export const COMPLIANCE_EVIDENCE_SOURCES = ["api", "worker", "admin_tool", "ci", "system"] as const;

/** Service or automation source that collected compliance evidence. */
export type ComplianceEvidenceSource = (typeof COMPLIANCE_EVIDENCE_SOURCES)[number];

/** Product-safe primitive metadata allowed in compliance evidence records. */
export type ComplianceEvidenceMetadata = Readonly<Record<string, string | number | boolean>>;

/** Input accepted when creating a normalized compliance evidence descriptor. */
export type ComplianceEvidenceInput = {
  /** Optional stable evidence ID. Defaults to a generated ID. */
  readonly id?: string | undefined;
  /** Organization scope when the evidence is tenant-specific. */
  readonly orgId?: string | undefined;
  /** Stable control ID this evidence supports. */
  readonly controlId: ComplianceControlId;
  /** Type of evidence artifact collected. */
  readonly evidenceType: ComplianceEvidenceType;
  /** Durable URI for the generated evidence artifact or manifest. */
  readonly evidenceUri: string;
  /** Optional digest for the evidence artifact. */
  readonly evidenceHash?: string | undefined;
  /** Optional deterministic collection timestamp for tests. */
  readonly collectedAt?: string | undefined;
  /** Actor, service, or automation that collected the evidence. */
  readonly collectedBy: string;
  /** Service or automation source that collected the evidence. */
  readonly source: ComplianceEvidenceSource;
  /** Evidence lifecycle status. Defaults to collected. */
  readonly status?: ComplianceEvidenceStatus | undefined;
  /** Product-safe summary metadata. */
  readonly summary?: Readonly<Record<string, unknown>> | undefined;
  /** Product-safe extended metadata. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

/** Normalized descriptor for one durable compliance evidence artifact. */
export type ComplianceEvidenceDescriptor = {
  /** Stable evidence ID. */
  readonly id: string;
  /** Organization scope when the evidence is tenant-specific. */
  readonly orgId?: string | undefined;
  /** Stable control ID this evidence supports. */
  readonly controlId: ComplianceControlId;
  /** Type of evidence artifact collected. */
  readonly evidenceType: ComplianceEvidenceType;
  /** Durable URI for the generated evidence artifact or manifest. */
  readonly evidenceUri: string;
  /** Optional digest for the evidence artifact. */
  readonly evidenceHash?: string | undefined;
  /** ISO timestamp when the evidence was collected. */
  readonly collectedAt: string;
  /** Actor, service, or automation that collected the evidence. */
  readonly collectedBy: string;
  /** Service or automation source that collected the evidence. */
  readonly source: ComplianceEvidenceSource;
  /** Evidence lifecycle status. */
  readonly status: ComplianceEvidenceStatus;
  /** Product-safe summary metadata. */
  readonly summary: ComplianceEvidenceMetadata;
  /** Product-safe extended metadata. */
  readonly metadata: ComplianceEvidenceMetadata;
};

/** Conservative default retention policy for MVP deployments. */
export const DEFAULT_RETENTION_POLICY = {
  auditLogDays: 365,
  billingUsageDays: 2555,
  contextBundleDays: 90,
  deleteOnRepoDisable: false,
  deleteOnUninstall: "after_grace_period",
  indexArtifactDays: 30,
  indexRetention: "while_enabled",
  operationalShortDays: 30,
  orgId: "default",
  promptArtifactDays: "disabled",
  rawDiffDays: 90,
  reviewArtifactDays: 90,
  sandboxArtifactDays: 30,
  securityEventDays: 365,
} as const satisfies RetentionPolicy;

/** Product permissions granted to each organization role. */
const PRODUCT_PERMISSIONS_BY_ROLE = {
  owner: PRODUCT_PERMISSIONS,
  admin: PRODUCT_PERMISSIONS.filter(
    (permission) => permission !== "billing:manage" && permission !== "security:manage",
  ),
  member: [
    "org:view",
    "installation:read",
    "repo:read",
    "review:read",
    "finding:read",
    "rule:read",
    "memory:read",
    "usage:read",
  ],
  viewer: [
    "org:view",
    "installation:read",
    "repo:read",
    "review:read",
    "finding:read",
    "rule:read",
    "memory:read",
    "usage:read",
  ],
} satisfies Record<ProductRole, readonly ProductPermission[]>;

/** Artifact types that are known to contain code or code-derived content. */
const codeArtifactTypes = new Set([
  "context_bundle",
  "embedding_index",
  "index_artifact",
  "llm_response_artifact",
  "prompt_artifact",
  "raw_diff",
  "source_chunk",
]);

/** Artifact types that are known to contain personal data. */
const personalDataArtifactTypes = new Set(["user_profile", "org_membership"]);

/** Artifact types that are internal-only operational data. */
const internalArtifactTypes = new Set(["audit_log", "security_event", "system_metric"]);

/** Artifact types that are public by design. */
const publicArtifactTypes = new Set(["marketing_content", "public_documentation"]);

/** High-risk event types that should page or trigger incident workflows by default. */
const criticalSecurityEventTypes = new Set([
  "secret_detected_in_log_or_artifact",
  "cross_tenant_access_attempt",
  "support_break_glass_started",
  "sandbox_escape_indicator",
  "private_key_rotation_failure",
  "llm_key_rotation_failure",
]);

/** Security event types that require urgent triage but are not always incidents. */
const highSecurityEventTypes = new Set([
  "artifact_download_spike",
  "invalid_webhook_signature_spike",
  "prompt_redaction_secret_detected",
  "sandbox_resource_abuse",
  "unexpected_github_permission_error",
]);

/** Metadata keys that must not be copied to security events. */
const sensitiveSecurityMetadataKeyPatterns = [
  "authorization",
  "code",
  "cookie",
  "database_url",
  "diff",
  "email",
  "password",
  "private_key",
  "prompt",
  "raw",
  "redis_url",
  "secret",
  "signed_url",
  "source",
  "token",
] as const;

/** Single built-in secret redaction pattern. */
type SecretRedactionPattern = {
  /** Product-safe category emitted when the pattern matches. */
  readonly kind: RedactionMatchKind;
  /** Global regular expression used to detect a secret-like value. */
  readonly pattern: RegExp;
  /** Replacement text or callback for the matched value. */
  readonly replacement: string | ((args: readonly unknown[]) => string);
};

/** Secret-like patterns redacted from logs, prompts, artifacts, and support views. */
const SECRET_REDACTION_PATTERNS: readonly SecretRedactionPattern[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    replacement: "[redacted-private-key]",
  },
  {
    kind: "github_token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
    replacement: "[redacted-github-token]",
  },
  {
    kind: "openai_api_key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu,
    replacement: "[redacted-llm-api-key]",
  },
  {
    kind: "aws_access_key_id",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
    replacement: "[redacted-aws-access-key-id]",
  },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    replacement: "[redacted-jwt]",
  },
  {
    kind: "credential_url",
    pattern: /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/giu,
    replacement: (args) => `${String(args[1] ?? "")}[redacted]@`,
  },
  {
    kind: "secret_assignment",
    pattern:
      /((?:"|')?(?:api[_-]?key|access[_-]?key|auth[_-]?token|password|passwd|private[_-]?key|pwd|secret|token)(?:"|')?\s*[:=]\s*(?:"|')?)(?!\[redacted)([^"',\s;}]+)/giu,
    replacement: (args) => `${String(args[1] ?? "")}[redacted]`,
  },
] as const;

/** Identity provider families that can back admin actors. */
export type AdminIdentityProvider = "oidc" | "saml" | "github_org";

/** Route exposure policy for privileged admin endpoints. */
export type AdminRouteExposure = "disabled" | "internal" | "public";

/** Coarse dashboard role derived from granular permissions for display only. */
export type AdminDisplayRole = "support" | "admin";

/** Provider-backed actor admitted to the admin control plane. */
export type AdminActor = {
  /** Actor category stored in audit records. */
  readonly actorType: "idp_user";
  /** Stable actor ID derived from provider and provider subject. */
  readonly actorUserId: string;
  /** Identity provider that authenticated the actor. */
  readonly provider: AdminIdentityProvider;
  /** Stable provider subject for this actor. */
  readonly providerSubject: string;
  /** Coarse role used only for legacy dashboard labels. */
  readonly role: AdminDisplayRole;
  /** Granular permissions granted by the identity provider. */
  readonly permissions: readonly AdminPermission[];
  /** Organization scope IDs granted by the identity provider. Use "*" for all organizations. */
  readonly orgIds: readonly string[];
  /** Repository scope IDs granted by the identity provider. Use "*" for all repositories. */
  readonly repoIds: readonly string[];
  /** Display name from the identity provider. */
  readonly displayName?: string | undefined;
  /** Primary email from the identity provider. */
  readonly email?: string | undefined;
};

/** Signed identity assertion emitted by an upstream OIDC, SAML, or GitHub org gateway. */
export type AdminIdentityAssertion = {
  /** Identity provider family that produced the assertion. */
  readonly provider: AdminIdentityProvider;
  /** Stable subject from the identity provider. */
  readonly providerSubject: string;
  /** Granular permissions granted to this actor. */
  readonly permissions: readonly AdminPermission[];
  /** Organization scope IDs granted to this actor. Use "*" for all organizations. */
  readonly orgIds?: readonly string[] | undefined;
  /** Repository scope IDs granted to this actor. Use "*" for all repositories. */
  readonly repoIds?: readonly string[] | undefined;
  /** GitHub organization login when provider is github_org. */
  readonly githubOrg?: string | undefined;
  /** Display name from the identity provider. */
  readonly displayName?: string | undefined;
  /** Primary email from the identity provider. */
  readonly email?: string | undefined;
};

/** Options for verifying a signed identity assertion. */
export type VerifyAdminIdentityAssertionOptions = {
  /** Expected identity provider configured for this deployment. */
  readonly expectedProvider: AdminIdentityProvider;
  /** Shared secret used by the upstream IdP gateway to sign assertions. */
  readonly assertionSecret: string;
  /** Base64url-encoded JSON identity assertion. */
  readonly encodedAssertion: string | undefined;
  /** Base64url HMAC-SHA256 signature over `${timestamp}.${encodedAssertion}`. */
  readonly signature: string | undefined;
  /** Millisecond epoch timestamp included in the signed assertion envelope. */
  readonly timestamp: string | undefined;
  /** Required GitHub organization login for github_org deployments. */
  readonly requiredGithubOrg?: string | undefined;
  /** Maximum allowed assertion clock skew in seconds. */
  readonly maxSkewSeconds?: number | undefined;
  /** Current time provider for tests. */
  readonly now?: (() => Date) | undefined;
};

/** Authenticated admin session persisted in the signed cookie. */
export type AdminSession = {
  /** Opaque session ID for audit correlation. */
  readonly sessionId: string;
  /** Provider-backed actor for this session. */
  readonly actor: AdminActor;
  /** CSRF token that must be supplied on cookie-authenticated mutations. */
  readonly csrfToken: string;
  /** ISO timestamp for token issuance. */
  readonly issuedAt: string;
  /** ISO timestamp for token expiration. */
  readonly expiresAt: string;
};

/** Secure cookie settings for control-plane sessions. */
export type AdminSessionCookieOptions = {
  /** Cookie name used for the signed session token. */
  readonly cookieName: string;
  /** Secret used to sign session tokens. */
  readonly sessionSecret: string;
  /** Whether the cookie must include the Secure flag. */
  readonly secure: boolean;
  /** SameSite policy for browser session cookies. */
  readonly sameSite?: "Strict" | "Lax" | "None" | undefined;
  /** Session lifetime in seconds. */
  readonly maxAgeSeconds: number;
  /** Cookie path for admin sessions. */
  readonly path?: string | undefined;
  /** Current time provider for tests. */
  readonly now?: (() => Date) | undefined;
};

/** Session cookie write returned by session manager operations. */
export type AdminSessionCookieWrite = {
  /** Authenticated session represented by the cookie. */
  readonly session: AdminSession;
  /** Serialized Set-Cookie header value. */
  readonly cookie: string;
};

/** Manager that creates, verifies, rotates, and clears admin session cookies. */
export type AdminSessionManager = {
  /** Creates a new signed admin session cookie for an actor. */
  readonly create: (actor: AdminActor) => AdminSessionCookieWrite;
  /** Reads and verifies a signed admin session cookie from a Cookie header. */
  readonly read: (cookieHeader: string | null) => AdminSession | undefined;
  /** Rotates a signed admin session cookie while preserving the actor and session ID. */
  readonly rotate: (session: AdminSession) => AdminSessionCookieWrite;
  /** Returns a Set-Cookie header that clears the admin session cookie. */
  readonly clear: () => string;
};

/** Structured security error raised during admin authentication. */
export class AdminSecurityError extends Error {
  /** Machine-readable error code. */
  public readonly code: string;

  /** HTTP status that should be returned for this error. */
  public readonly status: number;

  /** Creates an admin security error. */
  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AdminSecurityError";
    this.code = code;
    this.status = status;
  }
}

/** Creates a manager for signed admin session cookies. */
export function createAdminSessionManager(options: AdminSessionCookieOptions): AdminSessionManager {
  const cookiePath = options.path ?? "/admin";
  const sameSite = options.sameSite ?? "Strict";
  const now = options.now ?? (() => new Date());

  return {
    create: (actor) => {
      const issuedAt = now();
      const session = createSession(
        actor,
        randomToken("sess"),
        randomToken("csrf"),
        issuedAt,
        options.maxAgeSeconds,
      );
      return {
        session,
        cookie: sessionCookie(options, cookiePath, session),
      };
    },
    read: (cookieHeader) => {
      const token = parseCookieHeader(cookieHeader)[options.cookieName];
      if (!token) {
        return undefined;
      }

      const session = verifySignedPayload<AdminSession>(token, options.sessionSecret);
      if (!session) {
        return undefined;
      }

      return new Date(session.expiresAt).getTime() > now().getTime() ? session : undefined;
    },
    rotate: (session) => {
      const issuedAt = now();
      const rotated = createSession(
        session.actor,
        session.sessionId,
        randomToken("csrf"),
        issuedAt,
        options.maxAgeSeconds,
      );
      return {
        session: rotated,
        cookie: sessionCookie(options, cookiePath, rotated),
      };
    },
    clear: () =>
      serializeCookie(options.cookieName, "", {
        httpOnly: true,
        maxAgeSeconds: 0,
        path: cookiePath,
        sameSite,
        secure: options.secure,
      }),
  };
}

/** Verifies a signed identity assertion and converts it to an admin actor. */
export function verifyAdminIdentityAssertion(
  options: VerifyAdminIdentityAssertionOptions,
): AdminActor {
  const { encodedAssertion, signature, timestamp } = options;
  if (!encodedAssertion || !signature || !timestamp) {
    throw new AdminSecurityError(
      "admin_auth.missing_assertion",
      "Admin login requires a signed identity assertion.",
      401,
    );
  }

  validateAssertionTimestamp(timestamp, options.maxSkewSeconds ?? 300, options.now);
  verifyHmacEnvelope(options.assertionSecret, `${timestamp}.${encodedAssertion}`, signature);

  const assertion = parseIdentityAssertion(encodedAssertion);
  if (assertion.provider !== options.expectedProvider) {
    throw new AdminSecurityError(
      "admin_auth.provider_mismatch",
      "Admin identity assertion was issued by an unexpected provider.",
      401,
    );
  }

  if (
    assertion.provider === "github_org" &&
    options.requiredGithubOrg &&
    assertion.githubOrg !== options.requiredGithubOrg
  ) {
    throw new AdminSecurityError(
      "admin_auth.github_org_forbidden",
      "GitHub organization membership is required for admin access.",
      403,
    );
  }

  return actorFromAssertion(assertion);
}

/** Signs an identity assertion for integration tests and trusted gateway fixtures. */
export function signAdminIdentityAssertion(
  assertion: AdminIdentityAssertion,
  assertionSecret: string,
  timestamp = Date.now().toString(),
): {
  /** Base64url-encoded JSON identity assertion. */
  readonly encodedAssertion: string;
  /** Base64url HMAC-SHA256 signature over the assertion envelope. */
  readonly signature: string;
  /** Millisecond epoch timestamp included in the signed envelope. */
  readonly timestamp: string;
} {
  const encodedAssertion = encodeBase64Url(JSON.stringify(assertion));
  const signature = hmac(assertionSecret, `${timestamp}.${encodedAssertion}`);
  return { encodedAssertion, signature, timestamp };
}

/** Returns whether an actor has one granular permission. */
export function actorHasPermission(actor: AdminActor, permission: AdminPermission): boolean {
  return actor.permissions.includes(permission);
}

/** Returns whether an actor can access a scoped organization. */
export function actorCanAccessOrg(actor: AdminActor, orgId: string | undefined): boolean {
  if (actor.orgIds.includes("*")) {
    return true;
  }

  return orgId ? actor.orgIds.includes(orgId) : false;
}

/** Returns whether an actor can access a scoped repository. */
export function actorCanAccessRepo(
  actor: AdminActor,
  repoId: string | undefined,
  orgId: string | undefined,
): boolean {
  if (actor.repoIds.includes("*") || actor.orgIds.includes("*")) {
    return true;
  }

  return (repoId ? actor.repoIds.includes(repoId) : false) || actorCanAccessOrg(actor, orgId);
}

/** Returns dashboard capability flags derived from granular permissions. */
export function adminCapabilities(actor: AdminActor): Record<string, boolean> {
  return {
    canInspect: actorHasPermission(actor, "admin.inspect"),
    canPlanReplay: actorHasPermission(actor, "admin.replay.plan"),
    canExecuteReplay: actorHasPermission(actor, "admin.replay.execute"),
    canManageSettings: actorHasPermission(actor, "admin.settings.manage"),
    canViewAuditHistory: actorHasPermission(actor, "admin.audit.view"),
  };
}

/** Returns whether a string is a supported product role. */
export function isProductRole(value: string): value is ProductRole {
  return PRODUCT_ROLES.includes(value as ProductRole);
}

/** Returns whether a product role grants one product permission. */
export function productRoleHasPermission(
  role: ProductRole,
  permission: ProductPermission,
): boolean {
  const permissions: readonly ProductPermission[] = PRODUCT_PERMISSIONS_BY_ROLE[role];
  return permissions.includes(permission);
}

/** Returns the product permissions granted to one role. */
export function productPermissionsForRole(role: ProductRole): readonly ProductPermission[] {
  return PRODUCT_PERMISSIONS_BY_ROLE[role];
}

/** Returns the actor membership for one organization when present. */
export function productMembershipForOrg(
  actor: ProductActor,
  orgId: string,
): ProductMembership | undefined {
  return actor.memberships.find((membership) => membership.orgId === orgId);
}

/** Returns whether a product actor has one permission in an organization. */
export function productActorHasOrgPermission(
  actor: ProductActor,
  orgId: string,
  permission: ProductPermission,
): boolean {
  const membership = productMembershipForOrg(actor, orgId);
  return membership ? productRoleHasPermission(membership.role, permission) : false;
}

/** Returns whether a product actor can access a repository in one organization. */
export function productActorHasRepoPermission(
  actor: ProductActor,
  repoOrgId: string,
  permission: ProductPermission,
): boolean {
  return productActorHasOrgPermission(actor, repoOrgId, permission);
}

/** Returns dashboard capability flags derived from a product role. */
export function productCapabilities(role: ProductRole): Record<string, boolean> {
  return {
    canManageBilling: productRoleHasPermission(role, "billing:manage"),
    canManageMembers: productRoleHasPermission(role, "org:members:write"),
    canManageOrgSettings: productRoleHasPermission(role, "org:manage"),
    canManageRepositorySettings: productRoleHasPermission(role, "repo:settings:write"),
    canReadAuditHistory: productRoleHasPermission(role, "audit:read"),
    canReadUsage: productRoleHasPermission(role, "usage:read"),
    canRerunReviews: productRoleHasPermission(role, "review:rerun"),
  };
}

/** Returns whether a string is a supported data classification. */
export function isDataClassification(value: string): value is DataClassification {
  return DATA_CLASSIFICATIONS.includes(value as DataClassification);
}

/** Returns whether a string is a supported retention class. */
export function isRetentionClass(value: string): value is RetentionClass {
  return RETENTION_CLASSES.includes(value as RetentionClass);
}

/** Tags a value with a security data classification and reason. */
export function classifyValue<TValue>(
  value: TValue,
  classification: DataClassification,
  reason: string,
): ClassifiedValue<TValue> {
  return { classification, reason, value };
}

/** Classifies an artifact or artifact-like payload using conservative defaults. */
export function classifyArtifact(input: ClassifyArtifactInput): DataClassification {
  if (input.containsToken) {
    return "secret";
  }
  if (input.containsCode || input.containsPrompt || codeArtifactTypes.has(input.artifactType)) {
    return "customer_code";
  }
  if (input.containsPersonalData || personalDataArtifactTypes.has(input.artifactType)) {
    return "regulated_personal_data";
  }
  if (internalArtifactTypes.has(input.artifactType)) {
    return "internal";
  }
  if (publicArtifactTypes.has(input.artifactType)) {
    return "public";
  }

  return "customer_confidential";
}

/** Returns the default retention class for an artifact type. */
export function retentionClassForArtifactType(artifactType: string): RetentionClass {
  if (artifactType === "audit_log") {
    return "audit";
  }
  if (artifactType === "billing_usage") {
    return "billing";
  }
  if (artifactType === "security_event") {
    return "security";
  }
  if (artifactType === "index_artifact" || artifactType === "embedding_index") {
    return "index_lifetime";
  }
  if (
    artifactType === "sandbox_output" ||
    artifactType === "static_analysis_output" ||
    artifactType === "webhook_payload"
  ) {
    return "operational_short";
  }
  if (
    artifactType === "raw_diff" ||
    artifactType === "context_bundle" ||
    artifactType === "prompt_artifact" ||
    artifactType === "llm_response_artifact" ||
    artifactType === "static_report" ||
    artifactType === "review_summary"
  ) {
    return "review_artifact";
  }

  return "customer_configurable";
}

/** Resolves the retention decision for one artifact. */
export function resolveArtifactRetention(input: {
  /** Artifact type to evaluate. */
  readonly artifactType: string;
  /** Creation timestamp for expiration calculation. */
  readonly createdAt: string;
  /** Retention policy to apply. */
  readonly policy?: RetentionPolicy | undefined;
  /** Optional explicit retention class override. */
  readonly retentionClass?: RetentionClass | undefined;
}): RetentionDecision {
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY;
  const retentionClass = input.retentionClass ?? retentionClassForArtifactType(input.artifactType);
  const days = retentionDaysForArtifact(input.artifactType, retentionClass, policy);

  if (days === "disabled") {
    return {
      deleteOnRepoDisable: policy.deleteOnRepoDisable,
      deleteOnUninstall: policy.deleteOnUninstall,
      reason: `${input.artifactType} storage is disabled by retention policy.`,
      retentionClass,
      storage: "disabled",
    };
  }

  if (days === "while_enabled") {
    return {
      deleteOnRepoDisable: policy.deleteOnRepoDisable,
      deleteOnUninstall: policy.deleteOnUninstall,
      reason: `${input.artifactType} is retained while the repository remains enabled.`,
      retentionClass,
      storage: "allowed",
    };
  }

  return {
    deleteOnRepoDisable: policy.deleteOnRepoDisable,
    deleteOnUninstall: policy.deleteOnUninstall,
    expiresAt: addDays(input.createdAt, days),
    reason: `${input.artifactType} expires after ${days} day(s).`,
    retentionClass,
    storage: "allowed",
  };
}

/** Returns the default severity for one security event type. */
export function defaultSecurityEventSeverity(type: string): SecurityEventSeverity {
  if (criticalSecurityEventTypes.has(type)) {
    return "critical";
  }
  if (highSecurityEventTypes.has(type)) {
    return "high";
  }
  if (type.includes("denied") || type.includes("failure") || type.includes("rejected")) {
    return "medium";
  }

  return "info";
}

/** Returns whether a security event should trigger immediate alerting by default. */
export function shouldAlertSecurityEvent(event: Pick<SecurityEvent, "severity" | "type">): boolean {
  return event.severity === "critical" || criticalSecurityEventTypes.has(event.type);
}

/** Creates a normalized product-safe security event. */
export function createSecurityEvent(input: SecurityEventInput): SecurityEvent {
  return {
    id: input.id ?? randomToken("secevt"),
    metadata: sanitizeSecurityEventMetadata(input.metadata ?? {}),
    severity: input.severity ?? defaultSecurityEventSeverity(input.type),
    source: input.source,
    status: input.status ?? "new",
    type: input.type,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(input.repoId ? { repoId: input.repoId } : {}),
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.resourceType ? { resourceType: input.resourceType } : {}),
  };
}

/** Creates an in-memory security-event sink. */
export function createMemorySecurityEventSink(): MemorySecurityEventSink {
  const recordedEvents: SecurityEvent[] = [];

  return {
    clear: () => {
      recordedEvents.length = 0;
    },
    events: () => [...recordedEvents],
    record: (event) => {
      recordedEvents.push(event);
    },
  };
}

/** Creates a security-event sink that intentionally drops events. */
export function createNoopSecurityEventSink(): SecurityEventSink {
  return {
    record: () => {},
  };
}

/** Records a normalized security event and returns the recorded event. */
export function recordSecurityEvent(
  sink: SecurityEventSink,
  input: SecurityEventInput,
): SecurityEvent {
  const event = createSecurityEvent(input);
  sink.record(event);
  return event;
}

/** Returns whether a value is a known compliance control ID. */
export function isComplianceControlId(value: unknown): value is ComplianceControlId {
  return typeof value === "string" && COMPLIANCE_CONTROL_IDS.includes(value as ComplianceControlId);
}

/** Returns whether a value is a known compliance evidence type. */
export function isComplianceEvidenceType(value: unknown): value is ComplianceEvidenceType {
  return (
    typeof value === "string" && COMPLIANCE_EVIDENCE_TYPES.includes(value as ComplianceEvidenceType)
  );
}

/** Sanitizes compliance evidence metadata to keep exported records product-safe. */
export function sanitizeComplianceEvidenceMetadata(
  metadata: Readonly<Record<string, unknown>>,
): ComplianceEvidenceMetadata {
  return sanitizeProductSafeMetadata(metadata);
}

/** Creates a normalized product-safe compliance evidence descriptor. */
export function createComplianceEvidenceDescriptor(
  input: ComplianceEvidenceInput,
): ComplianceEvidenceDescriptor {
  const controlId = assertComplianceControlId(input.controlId);
  const evidenceType = assertComplianceEvidenceType(input.evidenceType);
  const evidenceUri = assertNonEmptyComplianceField(input.evidenceUri, "evidenceUri");
  const collectedBy = assertNonEmptyComplianceField(input.collectedBy, "collectedBy");
  const status = input.status ?? "collected";

  if (!COMPLIANCE_EVIDENCE_STATUSES.includes(status)) {
    throw new AdminSecurityError(
      "security.invalid_compliance_evidence_status",
      `Unsupported compliance evidence status: ${status}.`,
      400,
    );
  }
  if (!COMPLIANCE_EVIDENCE_SOURCES.includes(input.source)) {
    throw new AdminSecurityError(
      "security.invalid_compliance_evidence_source",
      `Unsupported compliance evidence source: ${input.source}.`,
      400,
    );
  }

  return {
    collectedAt: input.collectedAt ?? new Date().toISOString(),
    collectedBy,
    controlId,
    evidenceType,
    evidenceUri,
    id: input.id ?? randomToken("cmpev"),
    metadata: sanitizeComplianceEvidenceMetadata(input.metadata ?? {}),
    source: input.source,
    status,
    summary: sanitizeComplianceEvidenceMetadata(input.summary ?? {}),
    ...(input.evidenceHash ? { evidenceHash: input.evidenceHash } : {}),
    ...(input.orgId ? { orgId: input.orgId } : {}),
  };
}

/** Returns whether an HTTP method is safe from CSRF mutation checks. */
export function isCsrfSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/** Verifies a request CSRF header against the session-bound token. */
export function verifyCsrfToken(session: AdminSession, providedToken: string | null): boolean {
  return Boolean(providedToken) && constantTimeEqual(providedToken ?? "", session.csrfToken);
}

/** Returns retention duration for one artifact and class. */
function retentionDaysForArtifact(
  artifactType: string,
  retentionClass: RetentionClass,
  policy: RetentionPolicy,
): number | "disabled" | "while_enabled" {
  if (artifactType === "prompt_artifact") {
    return policy.promptArtifactDays;
  }
  if (artifactType === "raw_diff") {
    return policy.rawDiffDays;
  }
  if (artifactType === "context_bundle") {
    return policy.contextBundleDays;
  }
  if (artifactType === "sandbox_output" || artifactType === "static_analysis_output") {
    return policy.sandboxArtifactDays;
  }
  if (retentionClass === "index_lifetime") {
    return policy.indexRetention === "while_enabled" ? "while_enabled" : policy.indexArtifactDays;
  }
  if (retentionClass === "audit") {
    return policy.auditLogDays;
  }
  if (retentionClass === "billing") {
    return policy.billingUsageDays;
  }
  if (retentionClass === "security") {
    return policy.securityEventDays;
  }
  if (retentionClass === "operational_short") {
    return policy.operationalShortDays;
  }

  return policy.reviewArtifactDays;
}

/** Adds whole days to an ISO timestamp. */
function addDays(timestamp: string, days: number): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    throw new AdminSecurityError(
      "security.invalid_retention_timestamp",
      "Retention timestamp must be parseable.",
      400,
    );
  }

  return new Date(parsed + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Sanitizes security-event metadata to keep logs and alerts product-safe. */
function sanitizeSecurityEventMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean>> {
  return sanitizeProductSafeMetadata(metadata);
}

/** Sanitizes metadata to keep durable control records product-safe. */
function sanitizeProductSafeMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean>> {
  const sanitized: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!isSafeSecurityMetadataKey(key)) {
      continue;
    }
    if (typeof value === "boolean" || typeof value === "number") {
      sanitized[key] = value;
      continue;
    }
    if (typeof value === "string") {
      sanitized[key] = redactSecurityMetadataValue(value);
    }
  }

  return sanitized;
}

/** Validates one compliance evidence control ID. */
function assertComplianceControlId(controlId: string): ComplianceControlId {
  if (!isComplianceControlId(controlId)) {
    throw new AdminSecurityError(
      "security.invalid_compliance_control_id",
      `Unsupported compliance control ID: ${controlId}.`,
      400,
    );
  }

  return controlId;
}

/** Validates one compliance evidence type. */
function assertComplianceEvidenceType(evidenceType: string): ComplianceEvidenceType {
  if (!isComplianceEvidenceType(evidenceType)) {
    throw new AdminSecurityError(
      "security.invalid_compliance_evidence_type",
      `Unsupported compliance evidence type: ${evidenceType}.`,
      400,
    );
  }

  return evidenceType;
}

/** Returns a non-empty compliance field or raises a structured security error. */
function assertNonEmptyComplianceField(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new AdminSecurityError(
      "security.invalid_compliance_evidence_field",
      `Compliance evidence ${fieldName} must not be empty.`,
      400,
    );
  }

  return value.trim();
}

/** Returns whether one security-event metadata key is safe to persist and alert on. */
function isSafeSecurityMetadataKey(key: string): boolean {
  if (!/^[A-Za-z0-9_.-]{1,120}$/u.test(key)) {
    return false;
  }

  const normalizedKey = key.toLowerCase().replaceAll(/[.-]/gu, "_");
  if (normalizedKey === "statuscode" || normalizedKey === "status_code") {
    return true;
  }

  return !sensitiveSecurityMetadataKeyPatterns.some((pattern) => normalizedKey.includes(pattern));
}

/** Redacts secret-looking strings from allowed security-event metadata values. */
function redactSecurityMetadataValue(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/gu, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[redacted-token]")
    .slice(0, 1000);
}

/** Returns a signed session token string for a JSON-serializable payload. */
function signPayload(payload: unknown, secret: string): string {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  return `${encodedPayload}.${hmac(secret, encodedPayload)}`;
}

/** Verifies and decodes a signed session token payload. */
function verifySignedPayload<T>(token: string, secret: string): T | undefined {
  const [encodedPayload, signature, ...extra] = token.split(".");
  if (!encodedPayload || !signature || extra.length > 0) {
    return undefined;
  }

  try {
    verifyHmacEnvelope(secret, encodedPayload, signature);
    return JSON.parse(decodeBase64Url(encodedPayload)) as T;
  } catch {
    return undefined;
  }
}

/** Creates one session object with a fresh expiration timestamp. */
function createSession(
  actor: AdminActor,
  sessionId: string,
  csrfToken: string,
  issuedAt: Date,
  maxAgeSeconds: number,
): AdminSession {
  const expiresAt = new Date(issuedAt.getTime() + 1000 * maxAgeSeconds);
  return {
    actor,
    csrfToken,
    expiresAt: expiresAt.toISOString(),
    issuedAt: issuedAt.toISOString(),
    sessionId,
  };
}

/** Serializes a signed session cookie. */
function sessionCookie(
  options: AdminSessionCookieOptions,
  path: string,
  session: AdminSession,
): string {
  return serializeCookie(options.cookieName, signPayload(session, options.sessionSecret), {
    httpOnly: true,
    maxAgeSeconds: options.maxAgeSeconds,
    path,
    sameSite: options.sameSite ?? "Strict",
    secure: options.secure,
  });
}

/** Cookie serialization options used by the local cookie writer. */
type CookieSerializationOptions = {
  /** Whether the cookie should be inaccessible to JavaScript. */
  readonly httpOnly: boolean;
  /** Maximum age in seconds. */
  readonly maxAgeSeconds: number;
  /** Cookie path. */
  readonly path: string;
  /** SameSite policy. */
  readonly sameSite: "Strict" | "Lax" | "None";
  /** Whether the cookie requires HTTPS. */
  readonly secure: boolean;
};

/** Serializes a Set-Cookie header value. */
function serializeCookie(name: string, value: string, options: CookieSerializationOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAgeSeconds}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
    "HttpOnly",
  ];
  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

/** Parses a Cookie header into a lookup map. */
function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) {
    return {};
  }

  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.includes("="))
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        const key = part.slice(0, separatorIndex);
        const value = decodeURIComponent(part.slice(separatorIndex + 1));
        return [key, value];
      }),
  );
}

/** Validates an assertion timestamp against the configured skew. */
function validateAssertionTimestamp(
  timestamp: string,
  maxSkewSeconds: number,
  now: (() => Date) | undefined,
): void {
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs)) {
    throw new AdminSecurityError(
      "admin_auth.invalid_assertion_timestamp",
      "Admin identity assertion timestamp is invalid.",
      401,
    );
  }

  const currentMs = (now ?? (() => new Date()))().getTime();
  if (Math.abs(currentMs - timestampMs) > maxSkewSeconds * 1000) {
    throw new AdminSecurityError(
      "admin_auth.stale_assertion",
      "Admin identity assertion is outside the allowed clock skew.",
      401,
    );
  }
}

/** Verifies one base64url HMAC envelope. */
function verifyHmacEnvelope(secret: string, value: string, signature: string): void {
  if (!constantTimeEqual(hmac(secret, value), signature)) {
    throw new AdminSecurityError(
      "admin_auth.invalid_signature",
      "Admin identity assertion signature is invalid.",
      401,
    );
  }
}

/** Converts a signed assertion into an actor record. */
function actorFromAssertion(assertion: AdminIdentityAssertion): AdminActor {
  const permissions = uniquePermissions(assertion.permissions);
  if (permissions.length === 0) {
    throw new AdminSecurityError(
      "admin_auth.no_permissions",
      "Admin identity assertion grants no control-plane permissions.",
      403,
    );
  }

  return {
    actorType: "idp_user",
    actorUserId: `${assertion.provider}:${assertion.providerSubject}`,
    orgIds: normalizeScope(assertion.orgIds),
    permissions,
    provider: assertion.provider,
    providerSubject: assertion.providerSubject,
    repoIds: normalizeScope(assertion.repoIds),
    role: permissions.some(
      (permission) =>
        permission === "admin.replay.execute" || permission === "admin.settings.manage",
    )
      ? "admin"
      : "support",
    ...(assertion.displayName ? { displayName: assertion.displayName } : {}),
    ...(assertion.email ? { email: assertion.email } : {}),
  };
}

/** Parses and validates a base64url-encoded identity assertion. */
function parseIdentityAssertion(encodedAssertion: string): AdminIdentityAssertion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(encodedAssertion));
  } catch {
    throw new AdminSecurityError(
      "admin_auth.invalid_assertion",
      "Admin identity assertion must be valid encoded JSON.",
      401,
    );
  }

  const record = asRecord(parsed);
  const provider = record ? stringField(record, "provider") : undefined;
  const providerSubject = record ? stringField(record, "providerSubject") : undefined;
  if (!isAdminIdentityProvider(provider) || !providerSubject) {
    throw new AdminSecurityError(
      "admin_auth.invalid_assertion",
      "Admin identity assertion requires provider and providerSubject.",
      401,
    );
  }

  return {
    provider,
    providerSubject,
    permissions: parsePermissionArray(record?.permissions),
    orgIds: parseStringArray(record?.orgIds),
    repoIds: parseStringArray(record?.repoIds),
    githubOrg: record ? stringField(record, "githubOrg") : undefined,
    displayName: record ? stringField(record, "displayName") : undefined,
    email: record ? stringField(record, "email") : undefined,
  };
}

/** Returns a canonical secret provider for a user-facing provider string. */
function secretProviderFromString(value: string): SecretRefProvider | undefined {
  return SECRET_REF_PROVIDER_ALIASES[value.trim().toLowerCase()];
}

/** Returns a fetch implementation backed by the runtime global fetch function. */
async function defaultAwsSecretsManagerFetch(
  url: string,
  init: {
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly method: "POST";
  },
): Promise<AwsSecretsManagerFetchResponse> {
  if (typeof fetch !== "function") {
    throw new SecretResolutionError(
      "secret_provider_unsupported",
      "AWS Secrets Manager resolution requires a runtime fetch implementation.",
    );
  }

  const response = await fetch(url, {
    body: init.body,
    headers: init.headers,
    method: init.method,
  });
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
}

/** Returns a fetch implementation backed by the runtime global fetch function. */
async function defaultGcpSecretManagerFetch(
  url: string,
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly method: "GET";
  },
): Promise<GcpSecretManagerFetchResponse> {
  if (typeof fetch !== "function") {
    throw new SecretResolutionError(
      "secret_provider_unsupported",
      "GCP Secret Manager resolution requires a runtime fetch implementation.",
    );
  }

  const response = await fetch(url, {
    headers: init.headers,
    method: init.method,
  });
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
}

/** Signed AWS Secrets Manager request data. */
type AwsSecretsManagerSignedRequest = {
  /** Headers required for the signed AWS request. */
  readonly headers: Readonly<Record<string, string>>;
};

/** Input used to create a signed AWS Secrets Manager request. */
type CreateAwsSecretsManagerSignedRequestInput = {
  /** JSON request body. */
  readonly body: string;
  /** AWS credentials used for signing. */
  readonly credentials: AwsSecretsManagerCredentials;
  /** AWS endpoint URL. */
  readonly endpoint: string;
  /** Request time used for SigV4. */
  readonly now: Date;
  /** AWS region used for SigV4 scope. */
  readonly region: string;
};

/** Creates SigV4 headers for one AWS Secrets Manager JSON request. */
function createAwsSecretsManagerSignedRequest(
  input: CreateAwsSecretsManagerSignedRequestInput,
): AwsSecretsManagerSignedRequest {
  const endpoint = new URL(input.endpoint);
  const { amzDate, dateStamp } = awsRequestDateParts(input.now);
  const scope = `${dateStamp}/${input.region}/secretsmanager/aws4_request`;
  const payloadHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host: endpoint.host,
    "x-amz-date": amzDate,
    "x-amz-target": "secretsmanager.GetSecretValue",
  };
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const signedHeaders = Object.keys(headers).sort();
  const canonicalRequest = [
    "POST",
    awsCanonicalUri(endpoint),
    awsCanonicalQueryString(endpoint),
    signedHeaders.map((key) => `${key}:${awsCanonicalHeaderValue(headers[key] ?? "")}`).join("\n"),
    "",
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", awsSigningKey(input.credentials.secretAccessKey, input))
    .update(stringToSign)
    .digest("hex");
  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}`,
    `SignedHeaders=${signedHeaders.join(";")}`,
    `Signature=${signature}`,
  ].join(", ");

  return { headers };
}

/** Returns the AWS date stamp and timestamp for SigV4 signing. */
function awsRequestDateParts(date: Date): { readonly amzDate: string; readonly dateStamp: string } {
  const iso = date.toISOString();
  const dateStamp = iso.slice(0, 10).replaceAll("-", "");
  const timeStamp = iso.slice(11, 19).replaceAll(":", "");
  return { amzDate: `${dateStamp}T${timeStamp}Z`, dateStamp };
}

/** Returns the canonical URI used in an AWS SigV4 canonical request. */
function awsCanonicalUri(endpoint: URL): string {
  return endpoint.pathname.length > 0 ? endpoint.pathname : "/";
}

/** Returns the canonical query string used in an AWS SigV4 canonical request. */
function awsCanonicalQueryString(endpoint: URL): string {
  return [...endpoint.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${awsUriEncode(key)}=${awsUriEncode(value)}`)
    .join("&");
}

/** Encodes a URI part using AWS SigV4 percent-encoding rules. */
function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Normalizes one HTTP header value for AWS SigV4 canonicalization. */
function awsCanonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** Creates the derived AWS SigV4 signing key. */
function awsSigningKey(
  secretAccessKey: string,
  input: Pick<CreateAwsSecretsManagerSignedRequestInput, "now" | "region">,
): Buffer {
  const { dateStamp } = awsRequestDateParts(input.now);
  const dateKey = awsHmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = awsHmac(dateKey, input.region);
  const serviceKey = awsHmac(regionKey, "secretsmanager");
  return awsHmac(serviceKey, "aws4_request");
}

/** Returns an AWS SigV4 HMAC digest. */
function awsHmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

/** Returns a SHA-256 digest as lowercase hexadecimal text. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Product-safe parsed AWS GetSecretValue response data. */
type ParsedAwsSecretValueResponse = {
  /** Resolved secret value. */
  readonly value: string;
  /** Provider version identifier when returned by AWS. */
  readonly version?: string | undefined;
};

/** Parses an AWS GetSecretValue response body into product-safe resolved data. */
function parseAwsGetSecretValueResponse(
  responseText: string,
  ref: SecretRef,
): ParsedAwsSecretValueResponse {
  const record = parseJsonRecord(responseText);
  if (!record) {
    throw new SecretResolutionError(
      "secret_provider_error",
      "AWS Secrets Manager returned an invalid response envelope.",
      ref,
    );
  }

  const secretString = stringField(record, "SecretString");
  const secretBinary = stringField(record, "SecretBinary");
  const version = stringField(record, "VersionId") ?? ref.version;
  if (secretString) {
    return {
      value: secretString,
      ...(version ? { version } : {}),
    };
  }
  if (secretBinary) {
    return {
      value: Buffer.from(secretBinary, "base64").toString("utf8"),
      ...(version ? { version } : {}),
    };
  }

  throw new SecretResolutionError(
    "secret_provider_error",
    "AWS Secrets Manager response did not include a secret value.",
    ref,
  );
}

/** Creates a product-safe secret resolution error from an AWS error response. */
function awsSecretResolutionError(
  status: number,
  responseText: string,
  ref: SecretRef,
): SecretResolutionError {
  const record = parseJsonRecord(responseText);
  const errorType = normalizeAwsErrorType(
    stringField(record, "__type") ?? stringField(record, "code"),
  );
  if (errorType === "ResourceNotFoundException") {
    return new SecretResolutionError(
      "secret_not_found",
      `AWS Secrets Manager could not find secret ref ${secretRefLabel(ref)}.`,
      ref,
    );
  }

  return new SecretResolutionError(
    "secret_provider_error",
    `AWS Secrets Manager returned HTTP ${status}${errorType ? ` (${errorType})` : ""}.`,
    ref,
  );
}

/** Product-safe parsed GCP AccessSecretVersion response data. */
type ParsedGcpSecretAccessResponse = {
  /** Resolved secret value. */
  readonly value: string;
  /** Provider version identifier when returned by GCP. */
  readonly version?: string | undefined;
};

/** Creates the provider resource name for a GCP secret version. */
function gcpSecretVersionResourceName(ref: SecretRef): string {
  const name = ref.name.trim().replace(/^\/+|\/+$/gu, "");
  const version = ref.version ?? "latest";
  if (/^projects\/[^/]+\/secrets\/[^/]+\/versions\/[^/]+$/u.test(name)) {
    return name;
  }
  if (/^projects\/[^/]+\/secrets\/[^/]+$/u.test(name)) {
    return `${name}/versions/${version}`;
  }

  const shorthandParts = name.split("/");
  if (shorthandParts.length === 2 && shorthandParts.every((part) => part.trim().length > 0)) {
    const [projectId, secretId] = shorthandParts;
    return `projects/${projectId}/secrets/${secretId}/versions/${version}`;
  }

  throw new SecretResolutionError(
    "secret_ref_invalid",
    "GCP Secret Manager refs must use projects/{project}/secrets/{secret}[#version] or {project}/{secret}[#version].",
    ref,
  );
}

/** Builds the GCP AccessSecretVersion URL for one resource name. */
function gcpSecretAccessUrl(endpoint: string, resourceName: string): string {
  const normalizedEndpoint = endpoint.replace(/\/+$/u, "");
  const encodedResourceName = resourceName.split("/").map(encodeURIComponent).join("/");
  return `${normalizedEndpoint}/${encodedResourceName}:access`;
}

/** Parses a GCP AccessSecretVersion response body into product-safe resolved data. */
function parseGcpAccessSecretVersionResponse(
  responseText: string,
  ref: SecretRef,
): ParsedGcpSecretAccessResponse {
  const record = parseJsonRecord(responseText);
  const payload = asRecord(record?.payload);
  if (!record || !payload) {
    throw new SecretResolutionError(
      "secret_provider_error",
      "GCP Secret Manager returned an invalid response envelope.",
      ref,
    );
  }

  const data = stringField(payload, "data");
  if (!data) {
    throw new SecretResolutionError(
      "secret_provider_error",
      "GCP Secret Manager response did not include a secret value.",
      ref,
    );
  }

  const version = gcpVersionFromResourceName(stringField(record, "name")) ?? ref.version;
  return {
    value: Buffer.from(data, "base64").toString("utf8"),
    ...(version ? { version } : {}),
  };
}

/** Creates a product-safe secret resolution error from a GCP error response. */
function gcpSecretResolutionError(
  status: number,
  responseText: string,
  ref: SecretRef,
): SecretResolutionError {
  const record = parseJsonRecord(responseText);
  const error = asRecord(record?.error);
  const errorStatus = stringField(error, "status") ?? stringField(record, "status");
  if (status === 404 || errorStatus === "NOT_FOUND") {
    return new SecretResolutionError(
      "secret_not_found",
      `GCP Secret Manager could not find secret ref ${secretRefLabel(ref)}.`,
      ref,
    );
  }

  return new SecretResolutionError(
    "secret_provider_error",
    `GCP Secret Manager returned HTTP ${status}${errorStatus ? ` (${errorStatus})` : ""}.`,
    ref,
  );
}

/** Reads the version segment from a GCP secret version resource name. */
function gcpVersionFromResourceName(name: string | undefined): string | undefined {
  const match = /^projects\/[^/]+\/secrets\/[^/]+\/versions\/(?<version>[^/]+)$/u.exec(name ?? "");
  return match?.groups?.version;
}

/** Parses JSON text as an object record. */
function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/** Normalizes AWS JSON error type names. */
function normalizeAwsErrorType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const hashIndex = value.lastIndexOf("#");
  const withoutNamespace = hashIndex === -1 ? value : value.slice(hashIndex + 1);
  const colonIndex = withoutNamespace.indexOf(":");
  const normalized = colonIndex === -1 ? withoutNamespace : withoutNamespace.slice(0, colonIndex);
  return normalized.trim() || undefined;
}

/** Reads a non-empty environment value. */
function optionalEnvironmentString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Returns a product-safe error class name. */
function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name.trim() ? error.name : "UnknownError";
}

/** Returns unique literal secrets that are long enough to redact safely. */
function uniqueLiteralSecrets(values: readonly string[]): readonly string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length >= 8)
        .sort((left, right) => right.length - left.length),
    ),
  ];
}

/** Counts non-overlapping literal occurrences in text. */
function countLiteralOccurrences(value: string, literal: string): number {
  return Math.max(0, value.split(literal).length - 1);
}

/** Returns whether a value contains ASCII control characters. */
function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

/** Returns a unique list of valid admin permissions. */
function uniquePermissions(values: readonly AdminPermission[]): readonly AdminPermission[] {
  return [...new Set(values)];
}

/** Normalizes absent scope lists to no access. */
function normalizeScope(values: readonly string[] | undefined): readonly string[] {
  return values?.filter((value) => value.length > 0) ?? [];
}

/** Parses an unknown value as an admin permission array. */
function parsePermissionArray(value: unknown): readonly AdminPermission[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isAdminPermission);
}

/** Parses an unknown value as a string array. */
function parseStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/** Returns whether a string is an admin permission. */
function isAdminPermission(value: unknown): value is AdminPermission {
  return typeof value === "string" && ADMIN_PERMISSIONS.includes(value as AdminPermission);
}

/** Returns whether a string is an admin identity provider. */
function isAdminIdentityProvider(value: unknown): value is AdminIdentityProvider {
  return value === "oidc" || value === "saml" || value === "github_org";
}

/** Returns an object record when a value is a non-array object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads a string field from an object record. */
function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Creates a random URL-safe token with a purpose prefix. */
function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** Returns an HMAC-SHA256 signature as base64url text. */
function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/** Compares two strings in constant time. */
function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHmac("sha256", "compare").update(left).digest();
  const rightDigest = createHmac("sha256", "compare").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/** Encodes text using base64url. */
function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Decodes base64url text. */
function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
