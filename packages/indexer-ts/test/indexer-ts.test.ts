import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { validateIndexArtifact } from "@repo/indexer-driver";
import { describe, expect, it } from "vitest";
import { getTypeScriptIndexerCapabilities, indexTypeScriptRepository } from "../src/index";

describe("getTypeScriptIndexerCapabilities", () => {
  it("does not advertise incremental indexing before previous-artifact reuse exists", () => {
    expect(getTypeScriptIndexerCapabilities()).toMatchObject({
      supportsIncremental: false,
      supportsPreviousArtifact: false,
    });
  });
});

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

  it("emits canonical record type ordering across source files", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    await Promise.all([
      writeFile(join(workspacePath, "a.ts"), "export function a() { return true; }\n"),
      writeFile(
        join(workspacePath, "b.ts"),
        ['import { a } from "./a";', "export function b() { return a(); }", ""].join("\n"),
      ),
    ]);

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });
    const orderByType: Record<string, number> = { chunk: 2, edge: 3, file: 0, symbol: 1 };
    const orderIndexes = artifact.records.map((record) => orderByType[record.type] ?? 99);

    expect(orderIndexes).toEqual([...orderIndexes].sort((left, right) => left - right));
    expect(
      artifact.records.flatMap((record) => (record.type === "file" ? [record.path] : [])),
    ).toEqual(["a.ts", "b.ts"]);
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("indexes Node JavaScript modules and skips TypeScript declaration files", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    await Promise.all([
      writeFile(
        join(workspacePath, "common.cjs"),
        "function createService() { return true; }\nmodule.exports = { createService };\n",
      ),
      writeFile(join(workspacePath, "module.mjs"), "export function loadService() { return 1; }\n"),
      writeFile(join(workspacePath, "types.d.ts"), "export declare const typed: boolean;\n"),
      writeFile(join(workspacePath, "module-types.d.mts"), "export declare const esm: boolean;\n"),
      writeFile(join(workspacePath, "common-types.d.cts"), "export declare const cjs: boolean;\n"),
    ]);

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });

    const filePaths = artifact.records.flatMap((record) =>
      record.type === "file" ? [record.path] : [],
    );
    expect(filePaths).toEqual(["common.cjs", "module.mjs"]);
    expect(
      artifact.records.every((record) => !("path" in record) || !record.path.includes(".d.")),
    ).toBe(true);
    expect(artifact.manifest.languages).toEqual(["javascript"]);
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("skips generated and vendored sources before emitting records", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    await Promise.all([
      mkdir(join(workspacePath, "src", "generated"), { recursive: true }),
      mkdir(join(workspacePath, "src", "__generated__"), { recursive: true }),
      mkdir(join(workspacePath, "vendor"), { recursive: true }),
      mkdir(join(workspacePath, "node_modules", "pkg"), { recursive: true }),
      mkdir(join(workspacePath, "dist"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(workspacePath, "src", "app.ts"), "export const app = true;\n"),
      writeFile(
        join(workspacePath, "src", "generated", "client.ts"),
        "export const generatedClient = true;\n",
      ),
      writeFile(
        join(workspacePath, "src", "__generated__", "types.ts"),
        "export type GeneratedType = string;\n",
      ),
      writeFile(join(workspacePath, "src", "api.generated.ts"), "export const api = true;\n"),
      writeFile(
        join(workspacePath, "src", "content-marker.ts"),
        ["// Code generated by a test fixture. DO NOT EDIT.", "export const marker = true;"].join(
          "\n",
        ),
      ),
      writeFile(join(workspacePath, "vendor", "jquery.js"), "export const vendored = true;\n"),
      writeFile(
        join(workspacePath, "node_modules", "pkg", "index.js"),
        "export const dependency = true;\n",
      ),
      writeFile(join(workspacePath, "dist", "bundle.js"), "export const bundle = true;\n"),
    ]);

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });

    const filePaths = artifact.records.flatMap((record) =>
      record.type === "file" ? [record.path] : [],
    );
    expect(filePaths).toEqual(["src/app.ts"]);
    expect(artifact.manifest.fileCount).toBe(1);
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("normalizes CRLF source text before emitting chunks", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    await writeFile(
      join(workspacePath, "crlf.ts"),
      ["export function load() {", "  return true;", "}"].join("\r\n"),
    );

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });

    const chunkTexts = artifact.records.flatMap((record) =>
      record.type === "chunk" ? [record.text] : [],
    );
    expect(chunkTexts.length).toBeGreaterThan(0);
    expect(chunkTexts.every((text) => !text.includes("\r"))).toBe(true);
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("skips binary-looking source files before decoding them", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    await Promise.all([
      writeFile(join(workspacePath, "safe.ts"), "export const safe = true;\n"),
      writeFile(join(workspacePath, "binary.ts"), Buffer.from([0, 159, 146, 150, 0, 1, 2, 3])),
    ]);

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });

    const filePaths = artifact.records.flatMap((record) =>
      record.type === "file" ? [record.path] : [],
    );
    expect(filePaths).toEqual(["safe.ts"]);
    expect(artifact.records.some((record) => JSON.stringify(record).includes("binary.ts"))).toBe(
      false,
    );
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("skips symlinked source files before resolving them", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    const outsidePath = join(await mkdtemp(join(tmpdir(), "heimdall-indexer-outside-")), "leak.ts");
    await Promise.all([
      writeFile(join(workspacePath, "safe.ts"), "export const safe = true;\n"),
      writeFile(outsidePath, "export const leaked = true;\n"),
    ]);
    await symlink(outsidePath, join(workspacePath, "leak.ts"));

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });

    const filePaths = artifact.records.flatMap((record) =>
      record.type === "file" ? [record.path] : [],
    );
    expect(filePaths).toEqual(["safe.ts"]);
    expect(artifact.records.some((record) => JSON.stringify(record).includes("leaked"))).toBe(
      false,
    );
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("rejects unsafe workspace roots before discovery", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    const filePath = join(workspacePath, "not-a-directory.ts");
    await writeFile(filePath, "export const value = true;\n");
    const input = {
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    };

    await expect(indexTypeScriptRepository({ ...input, workspacePath: "" })).rejects.toThrow(
      "Workspace path is required.",
    );
    await expect(indexTypeScriptRepository({ ...input, workspacePath: filePath })).rejects.toThrow(
      "Workspace path must be a directory.",
    );
    await expect(
      indexTypeScriptRepository({ ...input, workspacePath: parse(workspacePath).root }),
    ).rejects.toThrow("Workspace path must not be a filesystem root.");
    await expect(indexTypeScriptRepository({ ...input, workspacePath: homedir() })).rejects.toThrow(
      "Workspace path must not be the user home directory.",
    );
  });
});
