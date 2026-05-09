import { spawnSync } from "node:child_process";

/** One command in the Railway release sequence. */
type ReleaseStep = {
  /** Arguments passed to the command. */
  readonly args: readonly string[];
  /** Executable command name. */
  readonly command: string;
  /** Human-readable release step name. */
  readonly name: string;
  /** Whether the step requires deployed Railway services and fresh operator auth. */
  readonly requiresLiveDeployment: boolean;
};

/** Parsed command-line options for the Railway release helper. */
type ReleaseOptions = {
  /** Whether to stop after local repository gates. */
  readonly localOnly: boolean;
};

/** Local gates that do not require deployed Railway services. */
const LOCAL_RELEASE_STEPS: readonly ReleaseStep[] = [
  {
    args: ["ci:control-plane:release"],
    command: "pnpm",
    name: "local release gates",
    requiresLiveDeployment: false,
  },
];

/** Live gates that require deployed API, dashboard, gateway, browser CDP, and fresh OAuth inputs. */
const LIVE_RELEASE_STEPS: readonly ReleaseStep[] = [
  {
    args: ["preflight:control-plane:staging"],
    command: "pnpm",
    name: "deployed preflight",
    requiresLiveDeployment: true,
  },
  {
    args: ["smoke:control-plane:staging"],
    command: "pnpm",
    name: "deployed API smoke",
    requiresLiveDeployment: true,
  },
  {
    args: ["e2e:dashboard"],
    command: "pnpm",
    name: "deployed dashboard E2E",
    requiresLiveDeployment: true,
  },
  {
    args: ["proof:control-plane:staging"],
    command: "pnpm",
    name: "staging proof evidence",
    requiresLiveDeployment: true,
  },
  {
    args: ["proof:sandbox:staging"],
    command: "pnpm",
    name: "sandbox staging proof evidence",
    requiresLiveDeployment: true,
  },
];

const LOCAL_ENV_PREFIXES_TO_UNSET = ["HEIMDALL_ADMIN_", "VITE_HEIMDALL_ADMIN_"] as const;

/** Runs the Railway release helper from the CLI. */
function main(): void {
  const options = readOptions(process.argv.slice(2));
  const steps = options.localOnly
    ? LOCAL_RELEASE_STEPS
    : [...LOCAL_RELEASE_STEPS, ...LIVE_RELEASE_STEPS];

  for (const step of steps) {
    runReleaseStep(step);
  }

  console.log(
    JSON.stringify(
      {
        mode: options.localOnly ? "local-only" : "full",
        steps: steps.map((step) => step.name),
        status: options.localOnly
          ? "local Railway release gates passed"
          : "Railway release gates passed",
      },
      null,
      2,
    ),
  );
}

/** Parses Railway release helper options. */
function readOptions(args: readonly string[]): ReleaseOptions {
  if (args.includes("--help")) {
    printHelpAndExit();
  }

  const unknown = args.filter((arg) => arg !== "--local-only");
  if (unknown.length > 0) {
    throw new Error(`Unknown option: ${unknown.join(", ")}`);
  }

  return { localOnly: args.includes("--local-only") };
}

/** Prints CLI help and exits successfully. */
function printHelpAndExit(): never {
  console.log(`Usage:
  pnpm release:control-plane:railway
  pnpm release:control-plane:railway -- --local-only

The full command runs local release gates, then deployed preflight, smoke, dashboard E2E, control-plane proof, and sandbox proof.
Use --local-only before Railway deploys or when fresh gateway/CDP proof inputs are unavailable.`);
  process.exit(0);
}

/** Runs one release step and fails immediately on non-zero exit. */
function runReleaseStep(step: ReleaseStep): void {
  console.log(`\n==> ${step.name}`);
  if (step.requiresLiveDeployment) {
    console.log("    requires deployed Railway URLs, fresh gateway OAuth, and proof env values");
  }

  const result = spawnSync(step.command, step.args, {
    env: getReleaseStepEnv(step),
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${step.name} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

/** Returns an environment for a release step without leaking staging auth into local tests. */
function getReleaseStepEnv(step: ReleaseStep): NodeJS.ProcessEnv {
  if (step.requiresLiveDeployment) {
    return process.env;
  }

  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !LOCAL_ENV_PREFIXES_TO_UNSET.some((prefix) => key.startsWith(prefix)),
    ),
  );
}

if (import.meta.main) {
  main();
}
