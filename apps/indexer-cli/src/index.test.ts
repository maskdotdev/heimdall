import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseIndexerCliArgs, runIndexerCli } from "./index";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
  tempRoots.length = 0;
});

describe("parseIndexerCliArgs", () => {
  it("parses request JSON and lets flags override optional output controls", async () => {
    const root = await createTempWorkspace();
    const requestPath = join(root, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        commitSha: "abcdef1",
        outputPath: "from-request.json",
        repoId: "repo_test",
        workspacePath: root,
      }),
      "utf8",
    );

    await expect(
      parseIndexerCliArgs(["index", "--request", requestPath, "--output", "-", "--pretty"]),
    ).resolves.toEqual({
      ok: true,
      request: {
        commitSha: "abcdef1",
        outputPath: "-",
        pretty: true,
        repoId: "repo_test",
        workspacePath: root,
      },
    });
  });

  it("rejects missing required index inputs", async () => {
    await expect(parseIndexerCliArgs(["index", "--repo-id", "repo_test"])).resolves.toEqual({
      help: false,
      message: "repoId, commitSha, and workspacePath are required.",
      ok: false,
    });
  });
});

describe("runIndexerCli", () => {
  it("prints TypeScript indexer capabilities as JSON", async () => {
    const output = memoryIo();
    const exitCode = await runIndexerCli(["capabilities", "--json"], output.io);

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toMatchObject({
      driverName: "heimdall-typescript-indexer",
      supportedArtifactSchemaVersions: ["index_artifact.v1"],
      supportedRequestSchemaVersions: ["index_request.v1"],
    });
  });

  it("indexes a local TypeScript workspace and writes an artifact JSON file", async () => {
    const root = await createTempWorkspace();
    const outputPath = join(root, "artifact.json");

    const output = memoryIo();
    const exitCode = await runIndexerCli(
      [
        "index",
        "--repo-id",
        "repo_test",
        "--commit-sha",
        "abcdef1",
        "--workspace",
        root,
        "--output",
        outputPath,
      ],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toEqual(
      expect.objectContaining({
        outputPath,
        recordCount: expect.any(Number),
      }),
    );

    const artifact = JSON.parse(await readFile(outputPath, "utf8")) as {
      readonly manifest: {
        readonly commitSha: string;
        readonly fileCount: number;
        readonly repoId: string;
        readonly recordCount: number;
      };
      readonly records: readonly { readonly type: string; readonly path?: string }[];
    };
    expect(artifact.manifest).toMatchObject({
      commitSha: "abcdef1",
      fileCount: 1,
      repoId: "repo_test",
    });
    expect(artifact.manifest.recordCount).toBe(artifact.records.length);
    expect(artifact.records).toContainEqual(
      expect.objectContaining({ path: "src/example.ts", type: "file" }),
    );
  });
});

/** Creates a temporary TypeScript workspace for CLI tests. */
async function createTempWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heimdall-indexer-cli-"));
  tempRoots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "example.ts"),
    'export function greet(name: string): string {\n  return "hello " + name;\n}\n',
    "utf8",
  );

  return root;
}

/** Creates in-memory stdout and stderr streams for CLI tests. */
function memoryIo(): {
  readonly io: {
    readonly stdout: { readonly write: (chunk: string) => void };
    readonly stderr: { readonly write: (chunk: string) => void };
  };
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  const chunks = { stderr: "", stdout: "" };

  return {
    io: {
      stderr: {
        write: (chunk: string) => {
          chunks.stderr += chunk;
        },
      },
      stdout: {
        write: (chunk: string) => {
          chunks.stdout += chunk;
        },
      },
    },
    stderr: () => chunks.stderr,
    stdout: () => chunks.stdout,
  };
}
