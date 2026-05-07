import {
  createGitHubProvider,
  type GitHubErrorCode,
  GitHubProviderError,
  type GitHubRequestObservation,
  type GitProvider,
} from "@repo/github";
import { serializePublisherError } from "@repo/publisher";
import { loadSmokeEnv, optionalEnv } from "./smoke-env";

/** Live GitHub provider-error smoke cases. */
type ProviderErrorSmokeCase = "not_found" | "validation";

/** Live provider-error smoke configuration. */
type SmokeConfig = {
  /** GitHub App ID used to mint installation tokens. */
  readonly githubAppId: string;
  /** GitHub App private key. */
  readonly githubPrivateKey: string;
  /** Heimdall or GitHub installation ID used by the provider. */
  readonly installationId: string;
  /** GitHub numeric installation ID. */
  readonly providerInstallationId: string;
  /** Repository owner login used for live probes. */
  readonly owner: string;
  /** Repository name used for live probes. */
  readonly repo: string;
  /** Probe cases to execute. */
  readonly cases: readonly ProviderErrorSmokeCase[];
  /** Missing repository name used by the not-found probe. */
  readonly notFoundRepo: string;
  /** Invalid head SHA used by the validation probe. */
  readonly invalidHeadSha: string;
  /** Whether mutation-shaped invalid write probes may run. */
  readonly allowInvalidWrite: boolean;
};

/** Result for one live provider-error probe. */
type ProviderErrorSmokeResult = {
  /** Probe case that ran. */
  readonly caseName: ProviderErrorSmokeCase;
  /** Provider error code expected by the probe. */
  readonly expectedCode: GitHubErrorCode;
  /** Provider error code observed from the live GitHub response. */
  readonly observedCode: GitHubErrorCode;
  /** Product-safe error message. */
  readonly message: string;
  /** HTTP status returned by GitHub, when present. */
  readonly status?: number;
  /** GitHub request ID returned by GitHub, when present. */
  readonly requestId?: string;
  /** Retry-after value returned by GitHub, when present. */
  readonly retryAfterSeconds?: number;
  /** Parsed rate-limit snapshot returned by GitHub, when present. */
  readonly rateLimit?: unknown;
  /** Publisher-facing serialization of the provider error. */
  readonly publisherError: ReturnType<typeof serializePublisherError>;
};

const DEFAULT_ERROR_SMOKE_CASES = [
  "not_found",
] as const satisfies readonly ProviderErrorSmokeCase[];

/** Loads and validates live provider-error smoke configuration. */
const loadConfig = (): SmokeConfig => {
  loadSmokeEnv();

  const githubPrivateKey =
    optionalEnv("GITHUB_PRIVATE_KEY") ?? optionalEnv("GITHUB_APP_PRIVATE_KEY");
  const githubAppId = optionalEnv("GITHUB_APP_ID");
  const providerInstallationId = optionalEnv("HEIMDALL_GITHUB_SMOKE_PROVIDER_INSTALLATION_ID");
  const owner = optionalEnv("HEIMDALL_GITHUB_SMOKE_OWNER");
  const repo = optionalEnv("HEIMDALL_GITHUB_SMOKE_REPO");
  const cases = providerErrorSmokeCases(optionalEnv("HEIMDALL_GITHUB_ERROR_SMOKE_CASES"));
  const allowInvalidWrite =
    optionalEnv("HEIMDALL_GITHUB_ERROR_SMOKE_ALLOW_INVALID_WRITE") === "true";
  const missing = [
    githubAppId ? undefined : "GITHUB_APP_ID",
    githubPrivateKey ? undefined : "GITHUB_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY",
    providerInstallationId ? undefined : "HEIMDALL_GITHUB_SMOKE_PROVIDER_INSTALLATION_ID",
    owner ? undefined : "HEIMDALL_GITHUB_SMOKE_OWNER",
    repo ? undefined : "HEIMDALL_GITHUB_SMOKE_REPO",
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing live GitHub provider-error smoke configuration: ${missing.join(", ")}.`,
    );
  }
  if (cases.includes("validation") && !allowInvalidWrite) {
    throw new Error(
      "Set HEIMDALL_GITHUB_ERROR_SMOKE_ALLOW_INVALID_WRITE=true to run the validation probe.",
    );
  }

  return {
    githubAppId: githubAppId ?? "",
    githubPrivateKey: (githubPrivateKey ?? "").replaceAll("\\n", "\n"),
    installationId:
      optionalEnv("HEIMDALL_GITHUB_SMOKE_INSTALLATION_ID") ?? providerInstallationId ?? "",
    providerInstallationId: providerInstallationId ?? "",
    owner: owner ?? "",
    repo: repo ?? "",
    cases,
    notFoundRepo:
      optionalEnv("HEIMDALL_GITHUB_ERROR_SMOKE_NOT_FOUND_REPO") ??
      `${repo ?? "repo"}-heimdall-missing-smoke`,
    invalidHeadSha:
      optionalEnv("HEIMDALL_GITHUB_ERROR_SMOKE_INVALID_HEAD_SHA") ?? "heimdall-invalid-sha",
    allowInvalidWrite,
  };
};

/** Parses the requested live provider-error smoke cases. */
const providerErrorSmokeCases = (value: string | undefined): readonly ProviderErrorSmokeCase[] => {
  if (!value) {
    return DEFAULT_ERROR_SMOKE_CASES;
  }

  const cases = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(providerErrorSmokeCase);

  return [...new Set(cases)];
};

/** Parses one live provider-error smoke case. */
const providerErrorSmokeCase = (value: string): ProviderErrorSmokeCase => {
  if (value === "not_found" || value === "validation") {
    return value;
  }

  throw new Error("HEIMDALL_GITHUB_ERROR_SMOKE_CASES must contain only not_found or validation.");
};

/** Runs the live provider-error smoke and prints structured evidence. */
async function main(): Promise<void> {
  const config = loadConfig();
  const observations: GitHubRequestObservation[] = [];
  const provider = createGitHubProvider(
    {
      appId: config.githubAppId,
      privateKey: config.githubPrivateKey,
    },
    { observeRequest: (observation) => observations.push(observation) },
  );

  const results: ProviderErrorSmokeResult[] = [];
  for (const caseName of config.cases) {
    results.push(await runProviderErrorProbe(caseName, config, provider));
  }

  console.log(
    JSON.stringify(
      {
        status: "passed",
        cases: results,
        observations,
      },
      null,
      2,
    ),
  );
}

/** Runs one provider-error smoke probe. */
async function runProviderErrorProbe(
  caseName: ProviderErrorSmokeCase,
  config: SmokeConfig,
  provider: GitProvider,
): Promise<ProviderErrorSmokeResult> {
  switch (caseName) {
    case "not_found":
      return expectProviderError({
        caseName,
        expectedCode: "github_not_found",
        run: () =>
          provider.fetchRepository({
            provider: "github",
            installationId: config.installationId,
            providerInstallationId: config.providerInstallationId,
            owner: config.owner,
            repo: config.notFoundRepo,
          }),
      });
    case "validation":
      return expectProviderError({
        caseName,
        expectedCode: "github_validation",
        run: () =>
          provider.createOrUpdateCheckRun({
            provider: "github",
            installationId: config.installationId,
            providerInstallationId: config.providerInstallationId,
            owner: config.owner,
            repo: config.repo,
            reviewRunId: "provider_error_smoke_validation",
            name: "Heimdall Provider Error Smoke",
            headSha: config.invalidHeadSha,
            status: "completed",
            conclusion: "neutral",
            title: "Provider error smoke",
            summary:
              "This guarded Heimdall provider-error smoke expects GitHub to reject the invalid head SHA.",
            annotations: [],
          }),
      });
  }
}

/** Runs a probe and returns the expected provider error. */
async function expectProviderError(input: {
  /** Probe case that is running. */
  readonly caseName: ProviderErrorSmokeCase;
  /** Provider code expected from the live GitHub response. */
  readonly expectedCode: GitHubErrorCode;
  /** Live provider operation expected to throw. */
  readonly run: () => Promise<unknown>;
}): Promise<ProviderErrorSmokeResult> {
  try {
    await input.run();
  } catch (error) {
    if (!(error instanceof GitHubProviderError)) {
      throw error;
    }
    if (error.code !== input.expectedCode) {
      throw new Error(
        `Expected ${input.caseName} to return ${input.expectedCode}, got ${error.code}.`,
      );
    }

    return {
      caseName: input.caseName,
      expectedCode: input.expectedCode,
      observedCode: error.code,
      message: error.message,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
      ...(error.rateLimit !== undefined ? { rateLimit: error.rateLimit } : {}),
      publisherError: serializePublisherError(error, `provider_error_smoke.${input.caseName}`),
    };
  }

  throw new Error(
    `Expected ${input.caseName} to fail with ${input.expectedCode}, but it succeeded.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
