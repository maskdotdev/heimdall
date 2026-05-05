/** Product-facing GitHub integration error categories. */
export type GitHubErrorCode =
  | "github_permission"
  | "github_rate_limit"
  | "github_secondary_rate_limit"
  | "github_not_found"
  | "github_validation"
  | "github_unavailable"
  | "github_installation_suspended"
  | "github_token"
  | "github_unknown";

/** Base error for GitHub provider failures. */
export class GitHubProviderError extends Error {
  /** Stable product error code. */
  public readonly code: GitHubErrorCode;
  /** HTTP status returned by GitHub, when available. */
  public readonly status: number | undefined;
  /** GitHub request identifier, when available. */
  public readonly requestId: string | undefined;
  /** Retry delay in seconds, when GitHub asks the caller to wait. */
  public readonly retryAfterSeconds: number | undefined;

  /** Creates a GitHub provider error. */
  public constructor(
    code: GitHubErrorCode,
    message: string,
    options: {
      readonly status?: number;
      readonly requestId?: string;
      readonly retryAfterSeconds?: number;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GitHubProviderError";
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Error raised when the GitHub App lacks permission for an operation. */
export class GitHubPermissionError extends GitHubProviderError {
  /** Creates a permission error. */
  public constructor(
    message: string,
    options: ConstructorParameters<typeof GitHubProviderError>[2],
  ) {
    super("github_permission", message, options);
    this.name = "GitHubPermissionError";
  }
}

/** Error raised when GitHub primary rate limits an operation. */
export class GitHubRateLimitError extends GitHubProviderError {
  /** Creates a rate limit error. */
  public constructor(
    message: string,
    options: ConstructorParameters<typeof GitHubProviderError>[2],
  ) {
    super("github_rate_limit", message, options);
    this.name = "GitHubRateLimitError";
  }
}

/** Error raised when GitHub secondary rate limits an operation. */
export class GitHubSecondaryRateLimitError extends GitHubProviderError {
  /** Creates a secondary rate limit error. */
  public constructor(
    message: string,
    options: ConstructorParameters<typeof GitHubProviderError>[2],
  ) {
    super("github_secondary_rate_limit", message, options);
    this.name = "GitHubSecondaryRateLimitError";
  }
}

/** Error raised when GitHub cannot find the requested resource. */
export class GitHubNotFoundError extends GitHubProviderError {
  /** Creates a not found error. */
  public constructor(
    message: string,
    options: ConstructorParameters<typeof GitHubProviderError>[2],
  ) {
    super("github_not_found", message, options);
    this.name = "GitHubNotFoundError";
  }
}

/** Error raised when GitHub rejects a request as invalid. */
export class GitHubValidationError extends GitHubProviderError {
  /** Creates a validation error. */
  public constructor(
    message: string,
    options: ConstructorParameters<typeof GitHubProviderError>[2],
  ) {
    super("github_validation", message, options);
    this.name = "GitHubValidationError";
  }
}

/** Error raised when GitHub is temporarily unavailable. */
export class GitHubUnavailableError extends GitHubProviderError {
  /** Creates an unavailable error. */
  public constructor(
    message: string,
    options: ConstructorParameters<typeof GitHubProviderError>[2],
  ) {
    super("github_unavailable", message, options);
    this.name = "GitHubUnavailableError";
  }
}

/** Error raised when an installation is suspended. */
export class GitHubInstallationSuspendedError extends GitHubProviderError {
  /** Creates an installation suspended error. */
  public constructor(
    message: string,
    options: ConstructorParameters<typeof GitHubProviderError>[2],
  ) {
    super("github_installation_suspended", message, options);
    this.name = "GitHubInstallationSuspendedError";
  }
}

/** Error raised when GitHub App token generation fails. */
export class GitHubTokenError extends GitHubProviderError {
  /** Creates a token error. */
  public constructor(
    message: string,
    options: ConstructorParameters<typeof GitHubProviderError>[2],
  ) {
    super("github_token", message, options);
    this.name = "GitHubTokenError";
  }
}
