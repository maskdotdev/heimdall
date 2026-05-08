#!/usr/bin/env bun

import { createDatabaseClient } from "@repo/db";
import {
  type CleanupIndexImportRowsResult,
  cleanupIndexImportRows,
  type ImportIndexArtifactResult,
  importIndexArtifact,
  readIndexArtifactFromUri,
} from "@repo/index-importer";
import {
  type AdminBackgroundJobDebugDetails,
  type AdminDebugService,
  type AdminIndexVersionInspection,
  type AdminPublisherDebugDetails,
  type AdminReplayAuditActor,
  type AdminReplayExecutionResult,
  type AdminReviewDebugDetails,
  type AdminReviewRunDebugBundle,
  type AdminUsageCostInspection,
  type AdminWebhookDebugDetails,
  type BackgroundJobReplayPlan,
  createAdminDebugService,
  type PublisherDryRunPlan,
  type PublisherReplayPlan,
  redactDebugBundleValue,
  renderPublisherDryRun,
  type WebhookReplayPlan,
} from "./index";

/** Environment variables used by the admin CLI. */
type AdminCliEnvironment = Readonly<Record<string, string | undefined>>;

/** Parsed admin CLI command. */
export type AdminCliCommand =
  | {
      /** Command discriminator. */
      readonly kind: "help";
    }
  | {
      /** Command discriminator. */
      readonly kind: "review_inspect";
      /** Review run to inspect. */
      readonly reviewRunId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "review_export";
      /** Review run to export. */
      readonly reviewRunId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "review_replay";
      /** Review run to replay. */
      readonly reviewRunId: string;
      /** Replay stage requested by the operator. */
      readonly stage: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Whether to dispatch the replay job after token confirmation. */
      readonly execute: boolean;
      /** Confirmation token required when execute is true. */
      readonly confirmationToken?: string;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "review_validation_replay";
      /** Review run to validation-replay. */
      readonly reviewRunId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Whether the operator attempted to dispatch the dry-run. */
      readonly execute: boolean;
      /** Confirmation token supplied with an unsupported dispatch attempt. */
      readonly confirmationToken?: string;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "review_retrieval_replay";
      /** Review run to retrieval-replay. */
      readonly reviewRunId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Whether the operator attempted to dispatch the dry-run. */
      readonly execute: boolean;
      /** Confirmation token supplied with an unsupported dispatch attempt. */
      readonly confirmationToken?: string;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "webhook_inspect";
      /** Webhook event to inspect. */
      readonly webhookEventId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "webhook_retry";
      /** Webhook event whose planned jobs should be retried. */
      readonly webhookEventId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Whether to dispatch the replay jobs after token confirmation. */
      readonly execute: boolean;
      /** Confirmation token required when execute is true. */
      readonly confirmationToken?: string;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "job_inspect";
      /** Durable background job to inspect. */
      readonly backgroundJobId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "job_retry";
      /** Durable background job to retry. */
      readonly backgroundJobId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Whether to dispatch the replay job after token confirmation. */
      readonly execute: boolean;
      /** Confirmation token required when execute is true. */
      readonly confirmationToken?: string;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "publisher_dry_run";
      /** Review run whose publisher output should be rendered. */
      readonly reviewRunId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "publisher_inspect";
      /** Review run whose publisher state should be inspected. */
      readonly reviewRunId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "publisher_replay";
      /** Review run whose publisher job should be replayed. */
      readonly reviewRunId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Whether to dispatch the replay job after token confirmation. */
      readonly execute: boolean;
      /** Confirmation token required when execute is true. */
      readonly confirmationToken?: string;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "usage_inspect";
      /** Review run whose usage and cost should be inspected. */
      readonly reviewRunId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "index_inspect";
      /** Imported index version to inspect. */
      readonly indexVersionId: string;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "index_import";
      /** Artifact URI or local path to import. */
      readonly artifactUri: string;
      /** Repository ID expected in the artifact manifest. */
      readonly repoId: string;
      /** Commit SHA expected in the artifact manifest. */
      readonly commitSha: string;
      /** Whether durable embedding batch jobs should be enqueued. */
      readonly enqueueEmbeddings: boolean;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    }
  | {
      /** Command discriminator. */
      readonly kind: "index_cleanup";
      /** Index version whose failed import rows should be cleaned. */
      readonly indexVersionId: string;
      /** Allows cleanup of non-failed versions as a documented break-glass operation. */
      readonly force: boolean;
      /** Whether output should be JSON. */
      readonly json: boolean;
      /** Optional direct database URL override. */
      readonly databaseUrl?: string;
    };

/** Result returned by CLI execution. */
export type AdminCliResult = {
  /** Process exit code. */
  readonly exitCode: number;
  /** Output intended for stdout. */
  readonly stdout?: string;
  /** Output intended for stderr. */
  readonly stderr?: string;
};

/** Parsed positional arguments and flags. */
type ParsedAdminCliArguments = {
  /** Positional arguments after flag parsing. */
  readonly positional: readonly string[];
  /** Parsed long flags. */
  readonly flags: ReadonlyMap<string, string | true>;
};

/** Service wrapper used by direct database CLI commands. */
type AdminCliServiceHandle = {
  /** Admin debug service backed by local database state. */
  readonly service: AdminDebugService;
  /** Drizzle database facade used by package-level helper commands. */
  readonly db: ReturnType<typeof createDatabaseClient>["db"];
  /** Closes resources opened for the service. */
  readonly close: () => Promise<void>;
};

/** Runs the admin CLI with process arguments. */
export async function runAdminCli(
  args: readonly string[],
  env: AdminCliEnvironment = process.env,
): Promise<AdminCliResult> {
  const command = parseAdminCliCommand(args);
  if (command.kind === "help") {
    return { exitCode: 0, stdout: adminCliUsage() };
  }

  const commandError = unsupportedAdminCliRequest(command);
  if (commandError) {
    return { exitCode: 2, stderr: commandError };
  }

  const productionGuard = directDatabaseProductionGuard(env);
  if (productionGuard) {
    return { exitCode: 2, stderr: productionGuard };
  }

  const handle = createLocalDatabaseService(command.databaseUrl, env);
  try {
    switch (command.kind) {
      case "review_inspect":
        return await runReviewInspectCommand(command, handle.service);
      case "review_export":
        return await runReviewExportCommand(command, handle.service, env);
      case "review_replay":
        return await runReviewReplayCommand(command, handle.service, env);
      case "review_retrieval_replay":
        return await runReviewRetrievalReplayCommand(command, handle.service);
      case "review_validation_replay":
        return await runReviewValidationReplayCommand(command, handle.service);
      case "webhook_inspect":
        return await runWebhookInspectCommand(command, handle.service);
      case "webhook_retry":
        return await runWebhookRetryCommand(command, handle.service, env);
      case "job_inspect":
        return await runJobInspectCommand(command, handle.service);
      case "job_retry":
        return await runJobRetryCommand(command, handle.service, env);
      case "publisher_dry_run":
        return await runPublisherDryRunCommand(command, handle);
      case "publisher_inspect":
        return await runPublisherInspectCommand(command, handle.service);
      case "publisher_replay":
        return await runPublisherReplayCommand(command, handle.service, env);
      case "usage_inspect":
        return await runUsageInspectCommand(command, handle.service);
      case "index_inspect":
        return await runIndexInspectCommand(command, handle.service);
      case "index_import":
        return await runIndexImportCommand(command, handle);
      case "index_cleanup":
        return await runIndexCleanupCommand(command, handle);
    }
  } finally {
    await handle.close();
  }
}

/** Parses raw admin CLI arguments into a command. */
export function parseAdminCliCommand(args: readonly string[]): AdminCliCommand {
  const parsed = parseAdminCliArguments(args);
  const [domain, action, reviewRunId] = parsed.positional;
  const json = parsed.flags.has("json");
  const databaseUrl = stringFlag(parsed.flags, "database-url");

  if (!domain || domain === "help" || parsed.flags.has("help")) {
    return { kind: "help" };
  }

  if (domain === "review" && action === "inspect" && reviewRunId) {
    return { kind: "review_inspect", ...(databaseUrl ? { databaseUrl } : {}), json, reviewRunId };
  }

  if (domain === "review" && action === "export" && reviewRunId) {
    return { kind: "review_export", ...(databaseUrl ? { databaseUrl } : {}), json, reviewRunId };
  }

  if (domain === "review" && action === "replay" && reviewRunId) {
    const stage = stringFlag(parsed.flags, "stage") ?? "review";
    const confirmationToken = stringFlag(parsed.flags, "confirmation-token");
    if (stage === "validation") {
      return {
        kind: "review_validation_replay",
        ...(confirmationToken ? { confirmationToken } : {}),
        ...(databaseUrl ? { databaseUrl } : {}),
        execute: parsed.flags.has("execute"),
        json,
        reviewRunId,
      };
    }
    if (stage === "retrieval") {
      return {
        kind: "review_retrieval_replay",
        ...(confirmationToken ? { confirmationToken } : {}),
        ...(databaseUrl ? { databaseUrl } : {}),
        execute: parsed.flags.has("execute"),
        json,
        reviewRunId,
      };
    }

    return {
      kind: "review_replay",
      ...(confirmationToken ? { confirmationToken } : {}),
      ...(databaseUrl ? { databaseUrl } : {}),
      execute: parsed.flags.has("execute"),
      json,
      reviewRunId,
      stage,
    };
  }

  if (domain === "webhook" && action === "inspect" && reviewRunId) {
    return {
      kind: "webhook_inspect",
      ...(databaseUrl ? { databaseUrl } : {}),
      json,
      webhookEventId: reviewRunId,
    };
  }

  if (domain === "webhook" && action === "retry" && reviewRunId) {
    const confirmationToken = stringFlag(parsed.flags, "confirmation-token");
    return {
      kind: "webhook_retry",
      ...(confirmationToken ? { confirmationToken } : {}),
      ...(databaseUrl ? { databaseUrl } : {}),
      execute: parsed.flags.has("execute"),
      json,
      webhookEventId: reviewRunId,
    };
  }

  if (domain === "job" && action === "inspect" && reviewRunId) {
    return {
      kind: "job_inspect",
      ...(databaseUrl ? { databaseUrl } : {}),
      backgroundJobId: reviewRunId,
      json,
    };
  }

  if (domain === "job" && action === "retry" && reviewRunId) {
    const confirmationToken = stringFlag(parsed.flags, "confirmation-token");
    return {
      kind: "job_retry",
      ...(confirmationToken ? { confirmationToken } : {}),
      ...(databaseUrl ? { databaseUrl } : {}),
      backgroundJobId: reviewRunId,
      execute: parsed.flags.has("execute"),
      json,
    };
  }

  if (domain === "publisher" && action === "dry-run" && reviewRunId) {
    return {
      kind: "publisher_dry_run",
      ...(databaseUrl ? { databaseUrl } : {}),
      json,
      reviewRunId,
    };
  }

  if (domain === "publisher" && action === "inspect" && reviewRunId) {
    return {
      kind: "publisher_inspect",
      ...(databaseUrl ? { databaseUrl } : {}),
      json,
      reviewRunId,
    };
  }

  if (domain === "publisher" && action === "replay" && reviewRunId) {
    const confirmationToken = stringFlag(parsed.flags, "confirmation-token");
    return {
      kind: "publisher_replay",
      ...(confirmationToken ? { confirmationToken } : {}),
      ...(databaseUrl ? { databaseUrl } : {}),
      execute: parsed.flags.has("execute"),
      json,
      reviewRunId,
    };
  }

  if (domain === "usage" && action === "inspect" && reviewRunId) {
    return {
      kind: "usage_inspect",
      ...(databaseUrl ? { databaseUrl } : {}),
      json,
      reviewRunId,
    };
  }

  if (domain === "index" && action === "inspect" && reviewRunId) {
    return {
      kind: "index_inspect",
      ...(databaseUrl ? { databaseUrl } : {}),
      indexVersionId: reviewRunId,
      json,
    };
  }

  if (domain === "index" && action === "import") {
    const artifactUri = requiredStringFlag(parsed.flags, "artifact", "index import");
    const repoId = requiredStringFlag(parsed.flags, "repo-id", "index import");
    const commitSha = stringFlag(parsed.flags, "commit") ?? stringFlag(parsed.flags, "commit-sha");
    if (!commitSha) {
      throw new Error("index import requires --commit <value>.");
    }
    return {
      kind: "index_import",
      ...(databaseUrl ? { databaseUrl } : {}),
      artifactUri,
      commitSha,
      enqueueEmbeddings: parsed.flags.has("enqueue-embeddings"),
      json,
      repoId,
    };
  }

  if (domain === "index" && (action === "cleanup" || action === "cleanup-import") && reviewRunId) {
    return {
      kind: "index_cleanup",
      ...(databaseUrl ? { databaseUrl } : {}),
      force: parsed.flags.has("force"),
      indexVersionId: reviewRunId,
      json,
    };
  }

  throw new Error(`Unsupported admin command: ${args.join(" ")}`);
}

/** Returns the help text for the admin CLI. */
export function adminCliUsage(): string {
  return [
    "Usage:",
    "  admin review inspect <reviewRunId> [--json] [--database-url <url>]",
    "  admin review export <reviewRunId> [--json] [--database-url <url>]",
    "  admin review replay <reviewRunId> [--stage review] [--execute --confirmation-token <token>] [--json] [--database-url <url>]",
    "  admin review replay <reviewRunId> --stage retrieval [--json] [--database-url <url>]",
    "  admin review replay <reviewRunId> --stage validation [--json] [--database-url <url>]",
    "  admin webhook inspect <webhookEventId> [--json] [--database-url <url>]",
    "  admin webhook retry <webhookEventId> [--execute --confirmation-token <token>] [--json] [--database-url <url>]",
    "  admin job inspect <backgroundJobId> [--json] [--database-url <url>]",
    "  admin job retry <backgroundJobId> [--execute --confirmation-token <token>] [--json] [--database-url <url>]",
    "  admin publisher dry-run <reviewRunId> [--json] [--database-url <url>]",
    "  admin publisher inspect <reviewRunId> [--json] [--database-url <url>]",
    "  admin publisher replay <reviewRunId> [--execute --confirmation-token <token>] [--json] [--database-url <url>]",
    "  admin usage inspect <reviewRunId> [--json] [--database-url <url>]",
    "  admin index inspect <indexVersionId> [--json] [--database-url <url>]",
    "  admin index import --artifact <uri> --repo-id <repoId> --commit <sha> [--enqueue-embeddings] [--json] [--database-url <url>]",
    "  admin index cleanup <indexVersionId> [--force] [--json] [--database-url <url>]",
    "",
    "The CLI uses direct local database access for development and operational drills.",
    "It refuses production direct-DB mode unless HEIMDALL_ADMIN_CLI_ALLOW_PRODUCTION_DB=true.",
  ].join("\n");
}

/** Runs review inspection and formats the result. */
async function runReviewInspectCommand(
  command: Extract<AdminCliCommand, { kind: "review_inspect" }>,
  service: AdminDebugService,
): Promise<AdminCliResult> {
  const details = await service.getReviewDebugDetails(command.reviewRunId);
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(details) : formatReviewInspection(details),
  };
}

/** Runs redacted debug bundle export and formats the result. */
async function runReviewExportCommand(
  command: Extract<AdminCliCommand, { kind: "review_export" }>,
  service: AdminDebugService,
  env: AdminCliEnvironment,
): Promise<AdminCliResult> {
  const bundle = await service.exportReviewRunDebugBundle(command.reviewRunId, cliActor(env));
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(bundle) : formatDebugBundleExport(bundle),
  };
}

/** Runs review replay planning or confirmed dispatch and formats the result. */
async function runReviewReplayCommand(
  command: Extract<AdminCliCommand, { kind: "review_replay" }>,
  service: AdminDebugService,
  env: AdminCliEnvironment,
): Promise<AdminCliResult> {
  if (command.stage !== "review") {
    return {
      exitCode: 2,
      stderr:
        "Only --stage review uses durable replay dispatch. Use --stage retrieval or --stage validation for non-mutating dry-runs.",
    };
  }

  const plan = await service.createReviewReplayPlan(command.reviewRunId);
  if (!command.execute) {
    return {
      exitCode: 0,
      stdout: command.json ? jsonOutput(plan) : formatReviewReplayPlan(plan),
    };
  }

  if (!command.confirmationToken) {
    return {
      exitCode: 2,
      stderr: "Replay dispatch requires --confirmation-token when --execute is set.",
    };
  }

  const result = await service.executeReviewReplay(
    command.reviewRunId,
    command.confirmationToken,
    cliActor(env),
  );
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(result) : formatReplayExecution(result),
  };
}

/** Runs retrieval replay in non-mutating dry-run mode and formats the result. */
async function runReviewRetrievalReplayCommand(
  command: Extract<AdminCliCommand, { kind: "review_retrieval_replay" }>,
  service: AdminDebugService,
): Promise<AdminCliResult> {
  const dryRun = await service.replayRetrievalDryRun(command.reviewRunId);
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(dryRun) : formatRetrievalReplayDryRun(dryRun),
  };
}

/** Runs validation replay in non-mutating dry-run mode and formats the result. */
async function runReviewValidationReplayCommand(
  command: Extract<AdminCliCommand, { kind: "review_validation_replay" }>,
  service: AdminDebugService,
): Promise<AdminCliResult> {
  const dryRun = await service.replayValidationDryRun(command.reviewRunId);
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(dryRun) : formatValidationReplayDryRun(dryRun),
  };
}

/** Runs webhook inspection and formats the result. */
async function runWebhookInspectCommand(
  command: Extract<AdminCliCommand, { kind: "webhook_inspect" }>,
  service: AdminDebugService,
): Promise<AdminCliResult> {
  const details = await service.getWebhookDebugDetails(command.webhookEventId);
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(details) : formatWebhookInspection(details),
  };
}

/** Runs webhook retry planning or confirmed dispatch and formats the result. */
async function runWebhookRetryCommand(
  command: Extract<AdminCliCommand, { kind: "webhook_retry" }>,
  service: AdminDebugService,
  env: AdminCliEnvironment,
): Promise<AdminCliResult> {
  if (command.execute && !command.confirmationToken) {
    return {
      exitCode: 2,
      stderr: "Webhook retry dispatch requires --confirmation-token when --execute is set.",
    };
  }

  const plan = await service.createWebhookReplayPlan(command.webhookEventId);
  if (!command.execute) {
    return {
      exitCode: 0,
      stdout: command.json ? jsonOutput(plan) : formatWebhookReplayPlan(plan),
    };
  }

  const confirmationToken = command.confirmationToken;
  if (!confirmationToken) {
    return {
      exitCode: 2,
      stderr: "Webhook retry dispatch requires --confirmation-token when --execute is set.",
    };
  }

  const result = await service.executeWebhookReplay(
    command.webhookEventId,
    confirmationToken,
    cliActor(env),
  );
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(result) : formatReplayExecution(result),
  };
}

/** Runs durable background job inspection and formats the result. */
async function runJobInspectCommand(
  command: Extract<AdminCliCommand, { kind: "job_inspect" }>,
  service: AdminDebugService,
): Promise<AdminCliResult> {
  const details = await service.getBackgroundJobDebugDetails(command.backgroundJobId);
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(details) : formatJobInspection(details),
  };
}

/** Runs durable background job retry planning or confirmed dispatch and formats the result. */
async function runJobRetryCommand(
  command: Extract<AdminCliCommand, { kind: "job_retry" }>,
  service: AdminDebugService,
  env: AdminCliEnvironment,
): Promise<AdminCliResult> {
  if (command.execute && !command.confirmationToken) {
    return {
      exitCode: 2,
      stderr: "Job retry dispatch requires --confirmation-token when --execute is set.",
    };
  }

  const plan = await service.createBackgroundJobReplayPlan(command.backgroundJobId);
  if (!command.execute) {
    return {
      exitCode: 0,
      stdout: command.json ? jsonOutput(plan) : formatBackgroundJobReplayPlan(plan),
    };
  }

  const confirmationToken = command.confirmationToken;
  if (!confirmationToken) {
    return {
      exitCode: 2,
      stderr: "Job retry dispatch requires --confirmation-token when --execute is set.",
    };
  }

  const result = await service.executeBackgroundJobReplay(
    command.backgroundJobId,
    confirmationToken,
    cliActor(env),
  );
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(result) : formatReplayExecution(result),
  };
}

/** Runs publisher dry-run rendering and formats the result. */
async function runPublisherDryRunCommand(
  command: Extract<AdminCliCommand, { kind: "publisher_dry_run" }>,
  serviceHandle: AdminCliServiceHandle,
): Promise<AdminCliResult> {
  const dryRun = await renderPublisherDryRun(command.reviewRunId, { db: serviceHandle.db });
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(dryRun) : formatPublisherDryRun(dryRun),
  };
}

/** Runs publisher state inspection and formats the result. */
async function runPublisherInspectCommand(
  command: Extract<AdminCliCommand, { kind: "publisher_inspect" }>,
  service: AdminDebugService,
): Promise<AdminCliResult> {
  const details = await service.getPublisherDebugDetails(command.reviewRunId);
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(details) : formatPublisherInspection(details),
  };
}

/** Runs publisher replay planning or confirmed dispatch and formats the result. */
async function runPublisherReplayCommand(
  command: Extract<AdminCliCommand, { kind: "publisher_replay" }>,
  service: AdminDebugService,
  env: AdminCliEnvironment,
): Promise<AdminCliResult> {
  const plan = await service.createPublisherReplayPlan(command.reviewRunId);
  if (!command.execute) {
    return {
      exitCode: 0,
      stdout: command.json ? jsonOutput(plan) : formatPublisherReplayPlan(plan),
    };
  }

  if (!command.confirmationToken) {
    return {
      exitCode: 2,
      stderr: "Publisher replay dispatch requires --confirmation-token when --execute is set.",
    };
  }

  const result = await service.executePublisherReplay(
    command.reviewRunId,
    command.confirmationToken,
    cliActor(env),
  );
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(result) : formatReplayExecution(result),
  };
}

/** Runs usage and cost inspection for one review run and formats the result. */
async function runUsageInspectCommand(
  command: Extract<AdminCliCommand, { kind: "usage_inspect" }>,
  service: AdminDebugService,
): Promise<AdminCliResult> {
  const inspection = await service.getUsageCostInspection(command.reviewRunId);
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(inspection) : formatUsageInspection(inspection),
  };
}

/** Runs index version inspection and formats the result. */
async function runIndexInspectCommand(
  command: Extract<AdminCliCommand, { kind: "index_inspect" }>,
  service: AdminDebugService,
): Promise<AdminCliResult> {
  const inspection = await service.getIndexVersionInspection(command.indexVersionId);
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(inspection) : formatIndexVersionInspection(inspection),
  };
}

/** Runs a local index artifact import command and formats the result. */
async function runIndexImportCommand(
  command: Extract<AdminCliCommand, { kind: "index_import" }>,
  serviceHandle: AdminCliServiceHandle,
): Promise<AdminCliResult> {
  const artifact = await readIndexArtifactFromUri(command.artifactUri);
  const manifestError = indexArtifactManifestError(command, artifact.manifest);
  if (manifestError) {
    return { exitCode: 2, stderr: manifestError };
  }

  const result = await importIndexArtifact(artifact, {
    artifactUri: command.artifactUri,
    db: serviceHandle.db,
    enqueueEmbeddings: command.enqueueEmbeddings,
  });
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(result) : formatIndexImportResult(result),
  };
}

/** Runs a guarded index import cleanup command and formats the result. */
async function runIndexCleanupCommand(
  command: Extract<AdminCliCommand, { kind: "index_cleanup" }>,
  serviceHandle: AdminCliServiceHandle,
): Promise<AdminCliResult> {
  const result = await cleanupIndexImportRows({
    db: serviceHandle.db,
    force: command.force,
    indexVersionId: command.indexVersionId,
  });
  return {
    exitCode: 0,
    stdout: command.json ? jsonOutput(result) : formatIndexCleanupResult(result),
  };
}

/** Creates a local database-backed admin service handle. */
function createLocalDatabaseService(
  databaseUrl: string | undefined,
  env: AdminCliEnvironment,
): AdminCliServiceHandle {
  const url = databaseUrl ?? env.DATABASE_URL ?? env.HEIMDALL_DB_TEST_URL;
  const client = createDatabaseClient({
    maxConnections: 1,
    ...(url ? { url } : {}),
  });
  return {
    close: client.close,
    db: client.db,
    service: createAdminDebugService({ db: client.db }),
  };
}

/** Parses long flags and positionals from command-line arguments. */
function parseAdminCliArguments(args: readonly string[]): ParsedAdminCliArguments {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const flag = arg.slice(2);
    const [name, inlineValue] = flag.split("=", 2);
    if (!name) {
      continue;
    }
    if (inlineValue !== undefined) {
      flags.set(name, inlineValue);
      continue;
    }

    const nextArg = args[index + 1];
    if (nextArg && !nextArg.startsWith("--")) {
      flags.set(name, nextArg);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }

  return { flags, positional };
}

/** Returns a command-level validation error before database resources are opened. */
function unsupportedAdminCliRequest(command: AdminCliCommand): string | undefined {
  if (
    command.kind === "review_validation_replay" &&
    (command.execute || command.confirmationToken)
  ) {
    return "Validation replay is dry-run only. Omit --execute and --confirmation-token.";
  }
  if (
    command.kind === "review_retrieval_replay" &&
    (command.execute || command.confirmationToken)
  ) {
    return "Retrieval replay is dry-run only. Omit --execute and --confirmation-token.";
  }

  return undefined;
}

/** Returns a string flag value when the flag was supplied with a value. */
function stringFlag(flags: ReadonlyMap<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Returns a required string flag or raises a command parse error. */
function requiredStringFlag(
  flags: ReadonlyMap<string, string | true>,
  name: string,
  commandName: string,
): string {
  const value = stringFlag(flags, name);
  if (!value) {
    throw new Error(`${commandName} requires --${name} <value>.`);
  }

  return value;
}

/** Returns an error when direct database mode appears to target production. */
function directDatabaseProductionGuard(env: AdminCliEnvironment): string | undefined {
  const environment = env.HEIMDALL_ENV ?? env.NODE_ENV;
  if (environment !== "production") {
    return undefined;
  }
  if (env.HEIMDALL_ADMIN_CLI_ALLOW_PRODUCTION_DB === "true") {
    return undefined;
  }

  return [
    "Admin CLI direct database mode is disabled for production.",
    "Use the authenticated admin API path, or set HEIMDALL_ADMIN_CLI_ALLOW_PRODUCTION_DB=true for a documented break-glass operation.",
  ].join(" ");
}

/** Returns an error when the artifact manifest does not match the import command scope. */
function indexArtifactManifestError(
  command: Extract<AdminCliCommand, { kind: "index_import" }>,
  manifest: Awaited<ReturnType<typeof readIndexArtifactFromUri>>["manifest"],
): string | undefined {
  if (manifest.repoId !== command.repoId) {
    return `Index artifact repoId ${manifest.repoId} does not match --repo-id ${command.repoId}.`;
  }
  if (manifest.commitSha !== command.commitSha) {
    return `Index artifact commitSha ${manifest.commitSha} does not match --commit ${command.commitSha}.`;
  }

  return undefined;
}

/** Builds the actor stored in CLI-triggered audit rows. */
function cliActor(env: AdminCliEnvironment): AdminReplayAuditActor {
  return {
    actorType: "internal_token",
    actorUserId: env.HEIMDALL_ADMIN_CLI_ACTOR_ID ?? "local_admin_cli",
    displayName: env.HEIMDALL_ADMIN_CLI_ACTOR_NAME ?? "Local admin CLI",
    provider: "local_cli",
    requestId: `cli_${Date.now()}`,
    role: "admin",
    ...(env.HEIMDALL_ADMIN_CLI_SUPPORT_SESSION_ID
      ? { supportSessionId: env.HEIMDALL_ADMIN_CLI_SUPPORT_SESSION_ID }
      : {}),
  };
}

/** Formats review inspection details for terminal output. */
function formatReviewInspection(details: AdminReviewDebugDetails): string {
  return [
    `Review run: ${details.reviewRun.reviewRunId}`,
    `Status: ${details.reviewRun.status}`,
    `Repository: ${details.reviewRun.repoId}`,
    `Pull request: #${details.reviewRun.pullRequestNumber}`,
    `Head SHA: ${details.reviewRun.headSha}`,
    `Stages: ${details.stageEvents.length}`,
    `Artifacts: ${details.artifacts.length}`,
    `Candidate findings: ${details.candidateFindings.length}`,
    `Validated findings: ${details.validatedFindings.length}`,
    `LLM calls: ${details.llmCalls.length}`,
    `Sandbox runs: ${details.sandboxRuns.length}`,
    `Related jobs: ${details.relatedJobs.length}`,
    `Failures: ${details.failures.length}`,
  ].join("\n");
}

/** Formats webhook inspection details for terminal output. */
function formatWebhookInspection(details: AdminWebhookDebugDetails): string {
  return [
    `Webhook event: ${details.webhookEvent.webhookEventId}`,
    `Provider: ${details.webhookEvent.provider}`,
    `Delivery: ${details.webhookEvent.deliveryId}`,
    `Event: ${details.webhookEvent.eventName}`,
    `Status: ${details.webhookEvent.status}`,
    `Expected jobs: ${details.expectedJobKeys.length}`,
    `Related jobs: ${details.relatedJobs.length}`,
    `Replay audits: ${details.replayAudits.length}`,
    `Failures: ${details.failures.length}`,
  ].join("\n");
}

/** Formats durable background job inspection details for terminal output. */
function formatJobInspection(details: AdminBackgroundJobDebugDetails): string {
  return [
    `Background job: ${details.job.backgroundJobId}`,
    `Queue: ${details.job.queueName}`,
    `Type: ${details.job.jobType}`,
    `Status: ${details.job.status}`,
    `Attempts: ${details.job.attempts}/${details.job.maxAttempts}`,
    `Job key: ${details.job.jobKey}`,
    `Embedding job: ${details.embeddingJob?.embeddingJobId ?? "none"}`,
    `Embedding items: ${details.embeddingJobItems?.length ?? 0}`,
    `Replay audits: ${details.replayAudits.length}`,
    `Failures: ${details.failures.length}`,
  ].join("\n");
}

/** Formats a debug bundle export summary for terminal output. */
function formatDebugBundleExport(bundle: AdminReviewRunDebugBundle): string {
  return [
    `Debug bundle: ${bundle.bundleId}`,
    `Admin action: ${bundle.adminActionId}`,
    `Debug export: ${bundle.debugExportId}`,
    `Audit log: ${bundle.auditLogId}`,
    `Review run: ${bundle.reviewRunId}`,
    `Payload hash: ${bundle.payloadHash}`,
    `Expires at: ${bundle.expiresAt}`,
  ].join("\n");
}

/** Formats a review replay plan for terminal output. */
function formatReviewReplayPlan(
  plan: Awaited<ReturnType<AdminDebugService["createReviewReplayPlan"]>>,
): string {
  return [
    `Replay action: ${plan.action}`,
    `Review run: ${plan.reviewRunId}`,
    `Queue: ${plan.queueName}`,
    `Replay job key: ${plan.jobKey}`,
    `Confirmation token: ${plan.confirmationToken}`,
    `Related jobs: ${plan.relatedJobs.length}`,
    `Failures: ${plan.failures.length}`,
    "",
    `Dispatch with: pnpm admin:replay-review ${plan.reviewRunId} --execute --confirmation-token ${plan.confirmationToken}`,
  ].join("\n");
}

/** Formats a webhook replay plan for terminal output. */
function formatWebhookReplayPlan(plan: WebhookReplayPlan): string {
  return [
    `Webhook retry action: ${plan.action}`,
    `Webhook event: ${plan.webhookEventId}`,
    `Delivery: ${plan.deliveryId}`,
    `Replay jobs: ${plan.jobs.length}`,
    `Eligible jobs: ${plan.eligibleJobIds.length}`,
    `Blocked jobs: ${plan.blockedJobIds.length}`,
    `Missing job keys: ${plan.missingJobKeys.length}`,
    `Failures: ${plan.failures.length}`,
    `Confirmation token: ${plan.confirmationToken}`,
    "",
    `Dispatch with: pnpm admin webhook retry ${plan.webhookEventId} --execute --confirmation-token ${plan.confirmationToken}`,
  ].join("\n");
}

/** Formats a background job replay plan for terminal output. */
function formatBackgroundJobReplayPlan(plan: BackgroundJobReplayPlan): string {
  return [
    `Job retry action: ${plan.action}`,
    `Background job: ${plan.backgroundJobId}`,
    `Current status: ${plan.currentStatus}`,
    `Queue: ${plan.queueName}`,
    `Type: ${plan.jobType}`,
    `Replay job key: ${plan.job.replayJobKey}`,
    `Failures: ${plan.failures.length}`,
    `Confirmation token: ${plan.confirmationToken}`,
    "",
    `Dispatch with: pnpm admin job retry ${plan.backgroundJobId} --execute --confirmation-token ${plan.confirmationToken}`,
  ].join("\n");
}

/** Formats a replay dispatch result for terminal output. */
function formatReplayExecution(result: AdminReplayExecutionResult): string {
  return [
    `Replay action: ${result.action}`,
    `Admin action: ${result.adminActionId}`,
    `Replay run: ${result.replayRunId}`,
    `Audit log: ${result.auditLogId}`,
    `Inserted jobs: ${result.insertedJobIds.length}`,
    `Existing jobs: ${result.existingJobIds.length}`,
  ].join("\n");
}

/** Formats retrieval replay dry-run output for terminal output. */
function formatRetrievalReplayDryRun(
  dryRun: Awaited<ReturnType<AdminDebugService["replayRetrievalDryRun"]>>,
): string {
  const unchangedCount = dryRun.comparisons.filter(
    (comparison) => comparison.status === "unchanged",
  ).length;
  const changedCount = dryRun.comparisons.filter(
    (comparison) => comparison.status === "changed",
  ).length;
  const addedCount = dryRun.comparisons.filter(
    (comparison) => comparison.status === "added",
  ).length;
  const removedCount = dryRun.comparisons.filter(
    (comparison) => comparison.status === "removed",
  ).length;
  return [
    `Retrieval replay: ${dryRun.reviewRunId}`,
    `Snapshot: ${dryRun.pullRequestSnapshotId}`,
    `Original items: ${dryRun.original?.itemCount ?? 0}`,
    `Replayed items: ${dryRun.replayed.itemCount}`,
    `Replayed tokens: ${dryRun.replayed.estimatedTokens} / ${dryRun.replayed.maxTokens}`,
    `Replayed mode: ${dryRun.replayed.retrievalMode ?? "unknown"}`,
    `Comparison: ${unchangedCount} unchanged / ${changedCount} changed / ${addedCount} added / ${removedCount} removed`,
    `Mutates production state: ${dryRun.mutatesProductionState}`,
    ...(dryRun.warnings.length > 0
      ? ["Warnings:", ...dryRun.warnings.map((warning) => `- ${warning}`)]
      : []),
  ].join("\n");
}

/** Formats validation replay dry-run output for terminal output. */
function formatValidationReplayDryRun(
  dryRun: Awaited<ReturnType<AdminDebugService["replayValidationDryRun"]>>,
): string {
  const unchangedCount = dryRun.comparisons.filter(
    (comparison) => comparison.status === "unchanged",
  ).length;
  const changedCount = dryRun.comparisons.filter(
    (comparison) => comparison.status === "changed",
  ).length;
  const addedCount = dryRun.comparisons.filter(
    (comparison) => comparison.status === "added",
  ).length;
  const removedCount = dryRun.comparisons.filter(
    (comparison) => comparison.status === "removed",
  ).length;
  return [
    `Validation replay: ${dryRun.reviewRunId}`,
    `Snapshot: ${dryRun.pullRequestSnapshotId}`,
    `Candidate findings: ${dryRun.candidateFindingCount}`,
    `Original decisions: ${dryRun.original.publish} publish / ${dryRun.original.reject} reject`,
    `Replayed decisions: ${dryRun.replayed.publish} publish / ${dryRun.replayed.reject} reject`,
    `Comparison: ${unchangedCount} unchanged / ${changedCount} changed / ${addedCount} added / ${removedCount} removed`,
    `Mutates production state: ${dryRun.mutatesProductionState}`,
    ...(dryRun.warnings.length > 0
      ? ["Warnings:", ...dryRun.warnings.map((warning) => `- ${warning}`)]
      : []),
  ].join("\n");
}

/** Formats a publisher dry-run result for terminal output. */
function formatPublisherDryRun(dryRun: PublisherDryRunPlan): string {
  return [
    `Publisher dry-run: ${dryRun.reviewRunId}`,
    `Repository: ${dryRun.repoId}`,
    `Pull request: #${dryRun.pullRequestNumber}`,
    `Head SHA: ${dryRun.headSha}`,
    `Findings: ${dryRun.findingCount}`,
    `Inline comments: ${dryRun.comments.inlineCommentCount}`,
    `Summary fallback findings: ${dryRun.comments.summaryFallbackCount}`,
    `Check conclusion: ${dryRun.checkRunConclusion}`,
    `Mutates external state: ${dryRun.mutatesExternalState}`,
  ].join("\n");
}

/** Formats publisher inspection details for terminal output. */
function formatPublisherInspection(details: AdminPublisherDebugDetails): string {
  return [
    `Publisher inspection: ${details.reviewRunId}`,
    `Repository: ${details.repoId}`,
    `Publish runs: ${details.publishRuns.length}`,
    `Operations: ${details.operations.length}`,
    `Check runs: ${details.outputs.checkRuns.length}`,
    `Reviews: ${details.outputs.reviews.length}`,
    `Summary comments: ${details.outputs.summaryComments.length}`,
    `Published findings: ${details.outputs.findings.length}`,
    `Related jobs: ${details.relatedJobs.length}`,
    `Replay audits: ${details.replayAudits.length}`,
    `Reconciliation status: ${details.reconciliation.status}`,
    `Reconciliation issues: ${details.reconciliation.issues.length}`,
    `Failures: ${details.failures.length}`,
  ].join("\n");
}

/** Formats a publisher replay plan for terminal output. */
function formatPublisherReplayPlan(plan: PublisherReplayPlan): string {
  return [
    `Publisher replay action: ${plan.action}`,
    `Review run: ${plan.dryRun.reviewRunId}`,
    `Repository: ${plan.dryRun.repoId}`,
    `Queue: ${plan.queueName}`,
    `Replay job key: ${plan.jobKey}`,
    `Findings: ${plan.dryRun.findingCount}`,
    `Inline comments: ${plan.dryRun.comments.inlineCommentCount}`,
    `Summary fallback findings: ${plan.dryRun.comments.summaryFallbackCount}`,
    `Reconciliation status: ${plan.reconciliation.status}`,
    `Reconciliation issues: ${plan.reconciliation.issues.length}`,
    `Confirmation token: ${plan.confirmationToken}`,
    "",
    `Dispatch with: pnpm admin publisher replay ${plan.dryRun.reviewRunId} --execute --confirmation-token ${plan.confirmationToken}`,
  ].join("\n");
}

/** Formats a usage/cost inspection result for terminal output. */
function formatUsageInspection(inspection: AdminUsageCostInspection): string {
  return [
    `Usage inspection: ${inspection.reviewRunId ?? "unscoped"}`,
    `Organization: ${inspection.orgId}`,
    `Repository: ${inspection.repoId ?? "all"}`,
    `Usage events: ${inspection.usageEvents.length}`,
    `Rollups: ${inspection.rollups.length}`,
    `Estimated cost: $${inspection.estimatedCostUsd}`,
    `Billable units: ${formatBillableUnits(inspection.billableUnits)}`,
    `Quota decisions: ${inspection.quotaDecisions.length}`,
    ...(inspection.warnings.length > 0
      ? ["Warnings:", ...inspection.warnings.map((warning) => `- ${warning}`)]
      : []),
  ].join("\n");
}

/** Formats an index version inspection result for terminal output. */
function formatIndexVersionInspection(inspection: AdminIndexVersionInspection): string {
  return [
    `Index version: ${inspection.indexVersionId}`,
    `Status: ${inspection.status}`,
    `Repository: ${inspection.repoId}`,
    `Commit: ${inspection.commitSha}`,
    `Index key: ${inspection.indexKey}`,
    `Artifact: ${inspection.artifactUri}`,
    `Counts: ${formatIndexCountSummaries(inspection)}`,
    `Mismatches: ${formatIndexCountMismatches(inspection)}`,
    `Import batches: ${inspection.importBatches.length}`,
    `Embedding jobs: ${inspection.embeddingJobs.length}`,
    ...(inspection.completedAt ? [`Completed at: ${inspection.completedAt}`] : []),
  ].join("\n");
}

/** Formats an index artifact import result for terminal output. */
function formatIndexImportResult(result: ImportIndexArtifactResult): string {
  return [
    `Index import: ${result.indexVersionId}`,
    `Import batch: ${result.importBatchId}`,
    `Files: ${result.fileCount}`,
    `Symbols: ${result.symbolCount}`,
    `Edges: ${result.edgeCount}`,
    `Chunks: ${result.chunkCount}`,
    `Embedding jobs: ${result.embeddingJobCount}`,
  ].join("\n");
}

/** Formats an index import cleanup result for terminal output. */
function formatIndexCleanupResult(result: CleanupIndexImportRowsResult): string {
  return [
    `Index cleanup: ${result.indexVersionId}`,
    `Original status: ${result.status}`,
    `Force: ${result.force}`,
    `Embedding jobs cleaned: ${result.embeddingJobIds.length}`,
    `Cleaned: ${result.cleaned}`,
  ].join("\n");
}

/** Formats index count summaries as compact terminal text. */
function formatIndexCountSummaries(inspection: AdminIndexVersionInspection): string {
  return [
    `files=${formatIndexCount(inspection.counts.files)}`,
    `symbols=${formatIndexCount(inspection.counts.symbols)}`,
    `edges=${formatIndexCount(inspection.counts.edges)}`,
    `chunks=${formatIndexCount(inspection.counts.chunks)}`,
    `embeddings=${formatIndexCount(inspection.counts.embeddings)}`,
  ].join(", ");
}

/** Formats a single index count summary as actual/expected terminal text. */
function formatIndexCount(count: { readonly actual: number; readonly expected: number }): string {
  return `${count.actual}/${count.expected}`;
}

/** Formats index count mismatches as compact terminal text. */
function formatIndexCountMismatches(inspection: AdminIndexVersionInspection): string {
  if (inspection.mismatches.length === 0) {
    return "none";
  }

  return inspection.mismatches
    .map(
      (mismatch) =>
        `${mismatch.metric} actual=${mismatch.actual} expected=${mismatch.expected} delta=${mismatch.delta}`,
    )
    .join("; ");
}

/** Formats billable unit totals as compact terminal text. */
function formatBillableUnits(units: Readonly<Record<string, number>>): string {
  const entries = Object.entries(units);
  if (entries.length === 0) {
    return "none";
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

/** Serializes CLI output as redacted, stable JSON. */
function jsonOutput(value: unknown): string {
  return JSON.stringify(redactDebugBundleValue(value), null, 2);
}

if (import.meta.main) {
  runAdminCli(process.argv.slice(2))
    .then(async (result) => {
      if (result.stdout) {
        process.stdout.write(`${result.stdout}\n`);
      }
      if (result.stderr) {
        process.stderr.write(`${result.stderr}\n`);
      }
      process.exitCode = result.exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
