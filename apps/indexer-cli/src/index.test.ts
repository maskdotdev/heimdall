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
        outputFormat: "json",
        pretty: true,
        repoId: "repo_test",
        workspacePath: root,
      },
    });
  });

  it("accepts run as the artifact creation command", async () => {
    await expect(
      parseIndexerCliArgs([
        "run",
        "--repo-id",
        "repo_test",
        "--commit-sha",
        "abcdef1",
        "--workspace",
        "/tmp/workspace",
      ]),
    ).resolves.toEqual({
      ok: true,
      request: {
        commitSha: "abcdef1",
        outputFormat: "json",
        pretty: false,
        repoId: "repo_test",
        workspacePath: "/tmp/workspace",
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

  it("rejects invalid request JSON output formats", async () => {
    const root = await createTempWorkspace();
    const requestPath = join(root, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        commitSha: "abcdef1",
        outputFormat: "tar",
        repoId: "repo_test",
        workspacePath: root,
      }),
      "utf8",
    );

    await expect(parseIndexerCliArgs(["index", "--request", requestPath])).resolves.toEqual({
      help: false,
      message: "Invalid artifact output format: tar",
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
        format: "json",
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

  it("indexes a local TypeScript workspace and writes a canonical split artifact directory", async () => {
    const root = await createTempWorkspace();
    const outputPath = join(root, "artifact");

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
        "--format",
        "split",
      ],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toEqual(
      expect.objectContaining({
        format: "split",
        outputPath,
        recordCount: expect.any(Number),
      }),
    );

    const manifest = JSON.parse(
      await readFile(join(outputPath, "index-manifest.json"), "utf8"),
    ) as {
      readonly artifactId: string;
      readonly commitSha: string;
      readonly fileCount: number;
      readonly recordCount: number;
      readonly repoId: string;
    };
    const recordsText = await readFile(join(outputPath, "records.jsonl"), "utf8");
    const records = recordsText
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly path?: string; readonly type: string });

    expect(recordsText.endsWith("\n")).toBe(true);
    expect(recordsText).not.toContain("\n\n");
    expect(manifest).toMatchObject({
      commitSha: "abcdef1",
      fileCount: 1,
      repoId: "repo_test",
    });
    expect(manifest.recordCount).toBe(records.length);
    expect(records).toContainEqual(
      expect.objectContaining({ path: "src/example.ts", type: "file" }),
    );

    const validationOutput = memoryIo();
    const validationExitCode = await runIndexerCli(
      ["validate", "--artifact", outputPath],
      validationOutput.io,
    );

    expect(validationExitCode).toBe(0);
    expect(validationOutput.stderr()).toBe("");
    expect(JSON.parse(validationOutput.stdout())).toEqual(
      expect.objectContaining({
        artifactId: manifest.artifactId,
        recordCount: manifest.recordCount,
        valid: true,
      }),
    );
  });

  it("rejects split artifacts without a directory output path", async () => {
    const root = await createTempWorkspace();
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
        "--format",
        "split",
      ],
      output.io,
    );

    expect(exitCode).toBe(1);
    expect(output.stdout()).toBe("");
    expect(output.stderr()).toBe("Split artifact output requires --output <directory>.\n");
  });

  it("returns artifact validation errors with the validation exit code", async () => {
    const root = await createTempWorkspace();
    const artifactPath = join(root, "artifact.json");

    await runIndexerCli(
      [
        "index",
        "--repo-id",
        "repo_test",
        "--commit-sha",
        "abcdef1",
        "--workspace",
        root,
        "--output",
        artifactPath,
      ],
      memoryIo().io,
    );
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
      readonly manifest: Readonly<Record<string, unknown>> & { readonly recordCount: number };
      readonly records: readonly unknown[];
    };
    await writeFile(
      artifactPath,
      `${JSON.stringify({
        ...artifact,
        manifest: {
          ...artifact.manifest,
          recordCount: artifact.manifest.recordCount + 1,
        },
      })}\n`,
      "utf8",
    );

    const output = memoryIo();
    const exitCode = await runIndexerCli(["validate", "--artifact", artifactPath], output.io);

    expect(exitCode).toBe(6);
    expect(output.stderr()).toBe("");
    expect(JSON.parse(output.stdout())).toEqual(
      expect.objectContaining({
        errorCount: expect.any(Number),
        errors: expect.arrayContaining([expect.stringContaining("recordCount")]),
        valid: false,
      }),
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
