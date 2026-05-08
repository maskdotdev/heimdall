import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { validateIndexArtifact } from "@repo/indexer-driver";
import { describe, expect, it } from "vitest";
import { getTypeScriptIndexerCapabilities, indexTypeScriptRepository } from "../src/index";

describe("getTypeScriptIndexerCapabilities", () => {
  it("does not advertise incremental indexing before previous-artifact reuse exists", () => {
    expect(getTypeScriptIndexerCapabilities()).toMatchObject({
      supportedLanguages: expect.arrayContaining(["python"]),
      supportedRecordTypes: expect.arrayContaining(["dependency", "route", "test_mapping"]),
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
    const orderByType: Record<string, number> = {
      chunk: 2,
      dependency: 3,
      diagnostic: 7,
      edge: 6,
      file: 0,
      route: 4,
      symbol: 1,
      test_mapping: 5,
    };
    const orderIndexes = artifact.records.map((record) => orderByType[record.type] ?? 99);

    expect(orderIndexes).toEqual([...orderIndexes].sort((left, right) => left - right));
    expect(
      artifact.records.flatMap((record) => (record.type === "file" ? [record.path] : [])),
    ).toEqual(["a.ts", "b.ts"]);
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("emits dependency records from package.json manifests", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    await writeFile(
      join(workspacePath, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@scope/runtime": "^1.0.0",
            react: "^19.0.0",
          },
          devDependencies: {
            typescript: "^5.0.0",
            vitest: "^4.0.0",
          },
          optionalDependencies: {
            sharp: "^0.33.0",
          },
          packageManager: "pnpm@10.0.0",
          peerDependencies: {
            vite: "^7.0.0",
          },
        },
        null,
        2,
      ),
    );

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });

    const dependencies = artifact.records.flatMap((record) =>
      record.type === "dependency"
        ? [
            {
              dependencyType: record.dependencyType,
              manifestPath: record.manifestPath,
              name: record.name,
              packageManager: record.packageManager,
              versionSpec: record.versionSpec,
            },
          ]
        : [],
    );

    expect(dependencies).toEqual([
      {
        dependencyType: "prod",
        manifestPath: "package.json",
        name: "@scope/runtime",
        packageManager: "pnpm",
        versionSpec: "^1.0.0",
      },
      {
        dependencyType: "prod",
        manifestPath: "package.json",
        name: "react",
        packageManager: "pnpm",
        versionSpec: "^19.0.0",
      },
      {
        dependencyType: "dev",
        manifestPath: "package.json",
        name: "typescript",
        packageManager: "pnpm",
        versionSpec: "^5.0.0",
      },
      {
        dependencyType: "dev",
        manifestPath: "package.json",
        name: "vitest",
        packageManager: "pnpm",
        versionSpec: "^4.0.0",
      },
      {
        dependencyType: "peer",
        manifestPath: "package.json",
        name: "vite",
        packageManager: "pnpm",
        versionSpec: "^7.0.0",
      },
      {
        dependencyType: "optional",
        manifestPath: "package.json",
        name: "sharp",
        packageManager: "pnpm",
        versionSpec: "^0.33.0",
      },
    ]);
    expect(artifact.manifest.recordCount).toBe(6);
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("resolves simple calls through named relative imports", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await Promise.all([
      writeFile(
        join(workspacePath, "src", "math.ts"),
        ["export function add(left: number, right: number) {", "  return left + right;", "}"].join(
          "\n",
        ),
      ),
      writeFile(
        join(workspacePath, "src", "service.ts"),
        [
          'import { add as sum } from "./math";',
          'import { readFile } from "node:fs/promises";',
          "",
          "export function total() {",
          "  return sum(1, 2);",
          "}",
          "",
          "export async function load(path: string) {",
          "  return readFile(path, 'utf8');",
          "}",
          "",
        ].join("\n"),
      ),
    ]);

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });

    const fileIdsByPath = new Map(
      artifact.records.flatMap((record) =>
        record.type === "file" ? [[record.path, record.fileId] as const] : [],
      ),
    );
    const symbolIdsByPathAndName = new Map(
      artifact.records.flatMap((record) =>
        record.type === "symbol"
          ? [[`${record.path}:${record.name}`, record.symbolId] as const]
          : [],
      ),
    );
    const importEdges = artifact.records.flatMap((record) =>
      record.type === "edge" && record.kind === "imports"
        ? [
            {
              fromId: record.fromId,
              toId: record.toId,
              toKind: record.toKind,
            },
          ]
        : [],
    );
    const importedCallEdges = artifact.records.flatMap((record) =>
      record.type === "edge" && record.kind === "calls" && record.metadata?.importPath === "./math"
        ? [
            {
              fromId: record.fromId,
              importedName: record.metadata.importedName,
              localName: record.metadata.localName,
              resolvedPath: record.metadata.resolvedPath,
              toId: record.toId,
            },
          ]
        : [],
    );

    expect(importEdges).toEqual([
      {
        fromId: fileIdsByPath.get("src/service.ts"),
        toId: "external:node:fs/promises",
        toKind: "external",
      },
      {
        fromId: fileIdsByPath.get("src/service.ts"),
        toId: fileIdsByPath.get("src/math.ts"),
        toKind: "file",
      },
    ]);
    expect(importedCallEdges).toEqual([
      {
        fromId: symbolIdsByPathAndName.get("src/service.ts:total"),
        importedName: "add",
        localName: "sum",
        resolvedPath: "src/math.ts",
        toId: symbolIdsByPathAndName.get("src/math.ts:add"),
      },
    ]);
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("resolves simple calls through tsconfig path aliases", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    await mkdir(join(workspacePath, "src", "lib"), { recursive: true });
    await Promise.all([
      writeFile(
        join(workspacePath, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              baseUrl: ".",
              paths: {
                "@lib/*": ["src/lib/*"],
              },
            },
          },
          null,
          2,
        ),
      ),
      writeFile(
        join(workspacePath, "src", "lib", "math.ts"),
        ["export function add(left: number, right: number) {", "  return left + right;", "}"].join(
          "\n",
        ),
      ),
      writeFile(
        join(workspacePath, "src", "service.ts"),
        [
          'import { add } from "@lib/math";',
          "",
          "export function total() {",
          "  return add(1, 2);",
          "}",
          "",
        ].join("\n"),
      ),
    ]);

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });

    const fileIdsByPath = new Map(
      artifact.records.flatMap((record) =>
        record.type === "file" ? [[record.path, record.fileId] as const] : [],
      ),
    );
    const symbolIdsByPathAndName = new Map(
      artifact.records.flatMap((record) =>
        record.type === "symbol"
          ? [[`${record.path}:${record.name}`, record.symbolId] as const]
          : [],
      ),
    );
    const aliasImportEdges = artifact.records.flatMap((record) =>
      record.type === "edge" &&
      record.kind === "imports" &&
      record.metadata?.importPath === "@lib/math"
        ? [
            {
              aliasPattern: record.metadata.aliasPattern,
              fromId: record.fromId,
              resolution: record.metadata.resolution,
              resolvedPath: record.metadata.resolvedPath,
              toId: record.toId,
              toKind: record.toKind,
            },
          ]
        : [],
    );
    const aliasCallEdges = artifact.records.flatMap((record) =>
      record.type === "edge" &&
      record.kind === "calls" &&
      record.metadata?.importPath === "@lib/math"
        ? [
            {
              aliasPattern: record.metadata.aliasPattern,
              fromId: record.fromId,
              resolution: record.metadata.resolution,
              resolvedPath: record.metadata.resolvedPath,
              toId: record.toId,
            },
          ]
        : [],
    );

    expect(aliasImportEdges).toEqual([
      {
        aliasPattern: "@lib/*",
        fromId: fileIdsByPath.get("src/service.ts"),
        resolution: "alias",
        resolvedPath: "src/lib/math.ts",
        toId: fileIdsByPath.get("src/lib/math.ts"),
        toKind: "file",
      },
    ]);
    expect(aliasCallEdges).toEqual([
      {
        aliasPattern: "@lib/*",
        fromId: symbolIdsByPathAndName.get("src/service.ts:total"),
        resolution: "alias",
        resolvedPath: "src/lib/math.ts",
        toId: symbolIdsByPathAndName.get("src/lib/math.ts:add"),
      },
    ]);
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("emits files, symbols, and chunks for Python sources", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    await writeFile(
      join(workspacePath, "service.py"),
      [
        "import os",
        "from app.auth import load_user, Session",
        "",
        "class UserService:",
        "    def update_email(self, user_id: str, email: str) -> str:",
        "        return normalize_email(email)",
        "",
        "def normalize_email(value: str) -> str:",
        "    return value.lower()",
        "",
        '@app.get("/sessions/{token}")',
        "async def validate_session(token: str) -> bool:",
        "    return normalize_email(token).startswith('session_')",
        "",
      ].join("\n"),
    );

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });

    const fileRecords = artifact.records.flatMap((record) =>
      record.type === "file" ? [{ language: record.language, path: record.path }] : [],
    );
    const symbolRecords = artifact.records.flatMap((record) =>
      record.type === "symbol"
        ? [
            {
              kind: record.kind,
              name: record.name,
              qualifiedName: record.qualifiedName,
              signature: record.signature,
            },
          ]
        : [],
    );
    const chunkLanguages = artifact.records.flatMap((record) =>
      record.type === "chunk" ? [record.language] : [],
    );
    const symbolIdsByName = new Map(
      artifact.records.flatMap((record) =>
        record.type === "symbol" ? [[record.name, record.symbolId] as const] : [],
      ),
    );
    const importEdges = artifact.records.flatMap((record) =>
      record.type === "edge" && record.kind === "imports"
        ? [
            {
              importedNames: record.metadata?.importedNames,
              syntax: record.metadata?.syntax,
              toId: record.toId,
            },
          ]
        : [],
    );
    const callEdges = artifact.records.flatMap((record) =>
      record.type === "edge" && record.kind === "calls"
        ? [{ fromId: record.fromId, toId: record.toId }]
        : [],
    );
    const routes = artifact.records.flatMap((record) =>
      record.type === "route"
        ? [
            {
              framework: record.framework,
              handlerSymbolId: record.handlerSymbolId,
              methods: record.methods,
              routePattern: record.routePattern,
            },
          ]
        : [],
    );

    expect(fileRecords).toEqual([{ language: "python", path: "service.py" }]);
    expect(symbolRecords).toEqual([
      {
        kind: "class",
        name: "UserService",
        qualifiedName: "UserService",
        signature: "class UserService:",
      },
      {
        kind: "method",
        name: "update_email",
        qualifiedName: "UserService.update_email",
        signature: "def update_email(self, user_id: str, email: str) -> str:",
      },
      {
        kind: "function",
        name: "normalize_email",
        qualifiedName: "normalize_email",
        signature: "def normalize_email(value: str) -> str:",
      },
      {
        kind: "function",
        name: "validate_session",
        qualifiedName: "validate_session",
        signature: "async def validate_session(token: str) -> bool:",
      },
    ]);
    expect(chunkLanguages).toEqual(["python", "python", "python", "python"]);
    expect(importEdges).toEqual([
      { importedNames: [], syntax: "import", toId: "external:os" },
      {
        importedNames: ["Session", "load_user"],
        syntax: "from_import",
        toId: "external:app.auth",
      },
    ]);
    expect(callEdges).toEqual([
      {
        fromId: symbolIdsByName.get("update_email"),
        toId: symbolIdsByName.get("normalize_email"),
      },
      {
        fromId: symbolIdsByName.get("validate_session"),
        toId: symbolIdsByName.get("normalize_email"),
      },
    ]);
    expect(routes).toEqual([
      {
        framework: "python-web",
        handlerSymbolId: symbolIdsByName.get("validate_session"),
        methods: ["GET"],
        routePattern: "/sessions/{token}",
      },
    ]);
    expect(artifact.manifest.languages).toEqual(["python"]);
    expect(artifact.manifest.parserVersions).toEqual({ python: "heuristic-python-v1" });
    expect(validateIndexArtifact(artifact)).toEqual([]);
  });

  it("emits route records and simple test mappings from cheap heuristics", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "heimdall-indexer-ts-"));
    await Promise.all([
      mkdir(join(workspacePath, "app", "api", "users", "[id]"), { recursive: true }),
      mkdir(join(workspacePath, "src"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(workspacePath, "src", "users.ts"),
        [
          "export function listUsers() {",
          "  return [];",
          "}",
          "",
          'router.get("/users", listUsers);',
          "",
        ].join("\n"),
      ),
      writeFile(
        join(workspacePath, "src", "users.test.ts"),
        [
          "import { listUsers } from './users';",
          "test('lists users', () => listUsers());",
          "",
        ].join("\n"),
      ),
      writeFile(
        join(workspacePath, "app", "api", "users", "[id]", "route.ts"),
        ["export function GET() {", "  return Response.json({ ok: true });", "}", ""].join("\n"),
      ),
    ]);

    const artifact = await indexTypeScriptRepository({
      repoId: "repo_123",
      commitSha: "1234567890abcdef",
      workspacePath,
    });

    const fileIdsByPath = new Map(
      artifact.records.flatMap((record) =>
        record.type === "file" ? [[record.path, record.fileId] as const] : [],
      ),
    );
    const symbolIdsByPathAndName = new Map(
      artifact.records.flatMap((record) =>
        record.type === "symbol"
          ? [[`${record.path}:${record.name}`, record.symbolId] as const]
          : [],
      ),
    );
    const routes = artifact.records.flatMap((record) =>
      record.type === "route"
        ? [
            {
              framework: record.framework,
              handlerSymbolId: record.handlerSymbolId,
              methods: record.methods,
              path: record.path,
              routePattern: record.routePattern,
            },
          ]
        : [],
    );
    const testMappings = artifact.records.flatMap((record) =>
      record.type === "test_mapping"
        ? [
            {
              targetFileId: record.targetFileId,
              testFileId: record.testFileId,
            },
          ]
        : [],
    );
    const testFiles = artifact.records.flatMap((record) =>
      record.type === "file" && record.isTest ? [record.path] : [],
    );

    expect(routes).toEqual([
      {
        framework: "nextjs",
        handlerSymbolId: symbolIdsByPathAndName.get("app/api/users/[id]/route.ts:GET"),
        methods: ["GET"],
        path: "app/api/users/[id]/route.ts",
        routePattern: "/api/users/:id",
      },
      {
        framework: "http-router",
        handlerSymbolId: symbolIdsByPathAndName.get("src/users.ts:listUsers"),
        methods: ["GET"],
        path: "src/users.ts",
        routePattern: "/users",
      },
    ]);
    expect(testFiles).toEqual(["src/users.test.ts"]);
    expect(testMappings).toEqual([
      {
        targetFileId: fileIdsByPath.get("src/users.ts"),
        testFileId: fileIdsByPath.get("src/users.test.ts"),
      },
    ]);
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
