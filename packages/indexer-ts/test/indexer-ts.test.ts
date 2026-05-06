import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateIndexArtifact } from "@repo/indexer-driver";
import { describe, expect, it } from "vitest";
import { indexTypeScriptRepository } from "../src/index";

describe("indexTypeScriptRepository", () => {
  it("emits files, symbols, chunks, and edges for TypeScript sources", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    await writeFile(
      join(workspacePath, "service.ts"),
      [
        'import { readFile } from "node:fs/promises";',
        "",
        "export class Service {",
        "  async load(path: string) {",
        "    return parse(await readFile(path, 'utf8'));",
        "  }",
        "}",
        "",
        "function parse(input: string) {",
        "  return input.trim();",
        "}",
      ].join("\n"),
    );

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });

    expect(artifact.manifest.fileCount).toBe(1);
    expect(
      artifact.records.some((record) => record.type === "symbol" && record.name === "Service"),
    ).toBe(true);
    expect(artifact.records.some((record) => record.type === "chunk")).toBe(true);
    expect(
      artifact.records.some((record) => record.type === "edge" && record.kind === "imports"),
    ).toBe(true);
    expect(
      artifact.records.some((record) => record.type === "edge" && record.kind === "calls"),
    ).toBe(true);
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });
});
