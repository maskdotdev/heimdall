import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Phase implementation spec directory. */
const PHASES_DIRECTORY = "phases";

/** Project status tracker file. */
const PROJECT_STATUS_FILE = "PROJECT_STATUS.md";

/** Status values accepted by the project tracker legend. */
const PROJECT_STATUS_VALUES = ["Not started", "Partial", "Done", "Deferred"] as const;

/** One implementation spec discovered from the phase directory. */
type PhaseSpec = {
  /** Phase number parsed from the filename prefix. */
  readonly phaseNumber: number;
  /** Phase spec file path relative to the repository root. */
  readonly path: string;
};

/** One phase tracker row parsed from PROJECT_STATUS.md. */
type PhaseStatusRow = {
  /** Phase number parsed from the tracker row. */
  readonly phaseNumber: number;
  /** Full raw Markdown table row. */
  readonly raw: string;
  /** Tracker status value. */
  readonly status: (typeof PROJECT_STATUS_VALUES)[number];
};

describe("project status phase coverage", () => {
  it("tracks every phase implementation spec exactly once", () => {
    const phaseSpecs = readPhaseSpecs();
    const trackerRows = readPhaseStatusRows();

    expect(phaseSpecs.map((phase) => phase.phaseNumber)).toEqual(
      trackerRows.map((row) => row.phaseNumber),
    );
    expect(phaseSpecs).toHaveLength(32);
    expect(trackerRows).toHaveLength(32);
  });

  it("keeps partial phase rows explicit about remaining work", () => {
    const partialRows = readPhaseStatusRows().filter((row) => row.status === "Partial");

    expect(partialRows.map((row) => row.phaseNumber)).toEqual([2, 24, 28, 30]);
    expect(
      partialRows.filter(
        (row) => !/\b(remaining|remains|tabled|provider-managed)\b/iu.test(row.raw),
      ),
    ).toEqual([]);
  });
});

/** Reads implementation spec files and returns their phase numbers in order. */
function readPhaseSpecs(): readonly PhaseSpec[] {
  return readdirSync(PHASES_DIRECTORY)
    .filter((fileName) => fileName.endsWith("-implementation-spec.md"))
    .map((fileName) => ({
      path: join(PHASES_DIRECTORY, fileName),
      phaseNumber: phaseNumberFromFileName(fileName),
    }))
    .sort((left, right) => left.phaseNumber - right.phaseNumber);
}

/** Reads phase tracker rows from PROJECT_STATUS.md. */
function readPhaseStatusRows(): readonly PhaseStatusRow[] {
  return readFileSync(PROJECT_STATUS_FILE, "utf8")
    .split("\n")
    .map(phaseStatusRowFromLine)
    .filter((row): row is PhaseStatusRow => row !== undefined)
    .sort((left, right) => left.phaseNumber - right.phaseNumber);
}

/** Parses one phase number from a phase implementation spec filename. */
function phaseNumberFromFileName(fileName: string): number {
  const match = /^(\d+)-.+-implementation-spec\.md$/u.exec(fileName);
  if (!match?.[1]) {
    throw new Error(`Phase spec filename must start with a numeric prefix: ${fileName}`);
  }

  return Number(match[1]);
}

/** Parses one project status tracker row from a Markdown table line. */
function phaseStatusRowFromLine(line: string): PhaseStatusRow | undefined {
  const match = /^\| #(\d+)\s+[^|]+ \| ([^|]+) \|/u.exec(line);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const status = phaseStatusValue(match[2].trim());
  return {
    phaseNumber: Number(match[1]),
    raw: line,
    status,
  };
}

/** Validates one parsed phase tracker status value. */
function phaseStatusValue(value: string): PhaseStatusRow["status"] {
  if (PROJECT_STATUS_VALUES.includes(value as PhaseStatusRow["status"])) {
    return value as PhaseStatusRow["status"];
  }

  throw new Error(`Unsupported project status value: ${value}`);
}
