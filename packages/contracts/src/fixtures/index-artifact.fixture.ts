import type { IndexManifest } from "#contracts/index-artifact/manifest";
import type {
  ChunkRecord,
  EdgeRecord,
  FileRecord,
  IndexRecord,
  SymbolRecord,
} from "#contracts/index-artifact/records";
import { hashA, hashB, ids, now } from "./common";

export const validIndexManifestFixture = {
  schemaVersion: "index_manifest.v1",
  artifactId: ids.artifactId,
  repoId: ids.repoId,
  commitSha: "2222222",
  indexerName: "heimdall-ts-indexer",
  indexerVersion: "0.1.0",
  chunkerVersion: "0.1.0",
  generatedAt: now,
  languages: ["typescript"],
  recordCount: 4,
  fileCount: 1,
  symbolCount: 1,
  edgeCount: 1,
  chunkCount: 1,
  parserVersions: { typescript: "5.9.3" },
  artifactHash: hashA,
} satisfies IndexManifest;

export const validFileRecordFixture = {
  type: "file",
  schemaVersion: "index_record.file.v1",
  fileId: ids.fileId,
  repoId: ids.repoId,
  commitSha: "2222222",
  path: "src/math.ts",
  language: "typescript",
  contentHash: hashB,
  sizeBytes: 64,
  lineCount: 3,
  isBinary: false,
  isGenerated: false,
  isTest: false,
  isVendored: false,
} satisfies FileRecord;

export const validSymbolRecordFixture = {
  type: "symbol",
  schemaVersion: "index_record.symbol.v1",
  symbolId: ids.symbolId,
  fileId: ids.fileId,
  repoId: ids.repoId,
  commitSha: "2222222",
  path: "src/math.ts",
  language: "typescript",
  name: "add",
  qualifiedName: "add",
  kind: "function",
  range: { startLine: 1, endLine: 3 },
  contentHash: hashB,
} satisfies SymbolRecord;

export const validEdgeRecordFixture = {
  type: "edge",
  schemaVersion: "index_record.edge.v1",
  edgeId: ids.edgeId,
  repoId: ids.repoId,
  commitSha: "2222222",
  fromId: ids.fileId,
  toId: ids.symbolId,
  fromKind: "file",
  toKind: "symbol",
  kind: "defines",
  confidence: 1,
} satisfies EdgeRecord;

export const validChunkRecordFixture = {
  type: "chunk",
  schemaVersion: "index_record.chunk.v1",
  chunkId: ids.chunkId,
  fileId: ids.fileId,
  symbolId: ids.symbolId,
  repoId: ids.repoId,
  commitSha: "2222222",
  path: "src/math.ts",
  language: "typescript",
  range: { startLine: 1, endLine: 3 },
  kind: "symbol",
  text: "export function add(a: number, b: number) { return Number(a) + Number(b); }",
  contentHash: hashB,
  tokenEstimate: 22,
} satisfies ChunkRecord;

export const validIndexRecordsFixture = [
  validFileRecordFixture,
  validSymbolRecordFixture,
  validEdgeRecordFixture,
  validChunkRecordFixture,
] satisfies IndexRecord[];
