import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validCandidateFindingFixture } from "@repo/contracts/fixtures/finding.fixture";
import {
  validChangedFileFixture,
  validDiffHunkFixture,
  validPullRequestSnapshotFixture,
} from "@repo/contracts/fixtures/pull-request.fixture";
import type { ChangedFile, DiffHunk } from "@repo/contracts/pull-request/diff";
import type { PullRequestSnapshot } from "@repo/contracts/pull-request/pull-request";
import type { ReviewPolicy } from "@repo/contracts/repository/settings";
import type { ContextBundle } from "@repo/contracts/review/context";
import type {
  CandidateFinding,
  FindingRejectionReason,
  ValidatedFinding,
} from "@repo/contracts/review/finding";
import type { MemoryFact } from "@repo/memory";
import { createPolicyFixture, type EffectiveReviewPolicy } from "@repo/rules";
import { describe, expect, it } from "vitest";
import {
  type FindingDuplicateGroup,
  type FindingValidationConfig,
  validateCandidateFindings,
} from "../src/index";

/** Root directory for validation fixture goldens. */
const validationFixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "validation",
);

/** Review policy fragment supported by validation fixture JSON. */
type ValidationFixturePolicy = {
  /** Optional review policy mode used to derive publish-plan expectations. */
  readonly reviewPolicy?: ReviewPolicy;
  /** Optional finding policy overrides. */
  readonly findings?: Partial<EffectiveReviewPolicy["findings"]>;
  /** Optional publishing policy overrides. */
  readonly publishing?: Partial<EffectiveReviewPolicy["publishing"]>;
};

/** Memory fact fragment supported by validation fixture JSON. */
type ValidationFixtureMemoryFact = {
  /** Durable memory fact ID. */
  readonly id: string;
  /** Finding dimensions this memory fact applies to. */
  readonly appliesTo: MemoryFact["appliesTo"];
  /** Optional human-readable memory content. */
  readonly content?: string;
};

/** Validation config supported by validation fixture JSON. */
type ValidationFixtureConfig = {
  /** Context item IDs available to evidence context reference validation. */
  readonly contextItemIds?: readonly string[];
  /** Enabled finding categories. */
  readonly enabledCategories?: FindingValidationConfig["enabledCategories"];
  /** Maximum accepted findings before budget rejection. */
  readonly maxPublishableFindings?: number;
  /** Minimum accepted severity. */
  readonly minimumSeverity?: FindingValidationConfig["minimumSeverity"];
  /** Previously published finding fragments for rerun dedupe. */
  readonly previousPublishedFindings?: readonly PreviousPublishedFindingFixture[];
  /** Policy fixture overrides. */
  readonly policy?: ValidationFixturePolicy;
  /** Repo rule text used by suppression. */
  readonly repoRules?: readonly string[];
  /** Memory facts used by suppression. */
  readonly memoryFacts?: readonly ValidationFixtureMemoryFact[];
};

/** Previously published finding fragment supported by validation fixture JSON. */
type PreviousPublishedFindingFixture = {
  /** Previously published finding fingerprint. */
  readonly fingerprint: string;
  /** Previously published finding title. */
  readonly title: string;
  /** Previously published finding body. */
  readonly body: string;
  /** Optional location override. */
  readonly location?: Partial<CandidateFinding["location"]>;
};

/** Changed-file fragment supported by validation fixture JSON. */
type ValidationFixtureChangedFile = {
  /** Path for the changed file. */
  readonly path: string;
  /** Added line numbers in this fixture file. */
  readonly addedLines?: readonly number[];
  /** Changed-file status. */
  readonly status?: ChangedFile["status"];
  /** Whether the file is binary. */
  readonly isBinary?: boolean;
  /** Whether the file is generated. */
  readonly isGenerated?: boolean;
  /** Whether the file is a test file. */
  readonly isTest?: boolean;
  /** Optional language label. */
  readonly language?: ChangedFile["language"];
};

/** Pull request snapshot fragment supported by validation fixture JSON. */
type ValidationFixtureSnapshot = {
  /** Default added lines for a single src/math.ts fixture file. */
  readonly addedLines?: readonly number[];
  /** Explicit changed files for multi-file or file-state fixtures. */
  readonly files?: readonly ValidationFixtureChangedFile[];
};

/** Candidate finding fragment supported by validation fixture JSON. */
type ValidationFixtureFinding = {
  /** Candidate finding ID. */
  readonly findingId: CandidateFinding["findingId"];
  /** Stable candidate fingerprint. */
  readonly fingerprint: string;
  /** Optional source name override. */
  readonly sourceName?: string;
  /** Optional finding category override. */
  readonly category?: CandidateFinding["category"];
  /** Optional finding severity override. */
  readonly severity?: CandidateFinding["severity"];
  /** Finding title. */
  readonly title: string;
  /** Finding body. */
  readonly body: string;
  /** Optional location override. */
  readonly location?: Partial<CandidateFinding["location"]>;
  /** Optional evidence override. An empty array exercises missing-evidence validation. */
  readonly evidence?: readonly ValidationFixtureEvidence[];
  /** Optional confidence override. */
  readonly confidence?: number;
  /** Optional suggested fix override. */
  readonly suggestedFix?: string;
};

/** Evidence fragment supported by validation fixture JSON. */
type ValidationFixtureEvidence = {
  /** Optional context item referenced by this evidence. */
  readonly contextItemId?: string;
  /** Optional evidence confidence override. */
  readonly confidence?: number;
  /** Evidence summary visible to validators. */
  readonly summary: string;
};

/** Duplicate group fragment expected by validation fixture JSON. */
type ValidationFixtureDuplicateGroup = Pick<
  FindingDuplicateGroup,
  "canonicalCandidateFindingId" | "duplicateCandidateFindingIds" | "groupKind"
>;

/** Publish-plan shape asserted by validation fixture JSON. */
type ValidationFixturePublishPlan = {
  /** Findings that would become check-run annotations. */
  readonly checkAnnotationCandidateFindingIds: readonly string[];
  /** Findings that would become inline comments. */
  readonly inlineCandidateFindingIds: readonly string[];
  /** Findings that would become a configured summary comment. */
  readonly summaryCandidateFindingIds: readonly string[];
};

/** Expected validation output for one fixture. */
type ValidationFixtureExpected = {
  /** Accepted candidate finding IDs in publish order. */
  readonly acceptedCandidateFindingIds: readonly string[];
  /** Duplicate groups that must be present. */
  readonly duplicateGroups?: readonly ValidationFixtureDuplicateGroup[];
  /** Expected publish-plan shape for accepted findings. */
  readonly publishPlan: ValidationFixturePublishPlan;
  /** Accepted candidate IDs in rank order. */
  readonly rankOrderCandidateFindingIds: readonly string[];
  /** Rejected candidates and their primary expected reasons. */
  readonly rejected: Record<string, readonly FindingRejectionReason[]>;
};

/** Complete validation fixture file. */
type ValidationFixture = {
  /** Fixture schema version. */
  readonly schemaVersion: "finding_validation_fixture.v1";
  /** Human-readable fixture name. */
  readonly name: string;
  /** Snapshot fragment. */
  readonly snapshot: ValidationFixtureSnapshot;
  /** Candidate finding fragments. */
  readonly findings: readonly ValidationFixtureFinding[];
  /** Optional validation config fragment. */
  readonly config?: ValidationFixtureConfig;
  /** Golden validation expectations. */
  readonly expected: ValidationFixtureExpected;
};

/** Loaded fixture with its source file name. */
type LoadedValidationFixture = {
  /** Fixture source file name. */
  readonly fileName: string;
  /** Parsed fixture contents. */
  readonly fixture: ValidationFixture;
};

describe("validation fixture goldens", () => {
  const fixtures = loadValidationFixtures();

  it("loads validation fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const loadedFixture of fixtures) {
    it(`${loadedFixture.fileName}: ${loadedFixture.fixture.name}`, () => {
      const config = validationConfigFromFixture(loadedFixture.fixture.config);
      const result = validateCandidateFindings({
        findings: loadedFixture.fixture.findings.map(candidateFindingFromFixture),
        snapshot: snapshotFromFixture(loadedFixture.fixture.snapshot),
        timestamp: validCandidateFindingFixture.createdAt,
        ...(config ? { config } : {}),
      });

      expect(result.accepted.map((finding) => finding.candidateFindingId)).toEqual(
        loadedFixture.fixture.expected.acceptedCandidateFindingIds,
      );
      expect(result.accepted.map((finding) => finding.candidateFindingId)).toEqual(
        loadedFixture.fixture.expected.rankOrderCandidateFindingIds,
      );
      expect(result.accepted.map((finding) => finding.rank)).toEqual(
        loadedFixture.fixture.expected.rankOrderCandidateFindingIds.map((_, index) => index + 1),
      );

      const rejectionReasons = rejectionReasonsByCandidateId(result.rejected);
      for (const [candidateFindingId, expectedReasons] of Object.entries(
        loadedFixture.fixture.expected.rejected,
      )) {
        expect(rejectionReasons[candidateFindingId]).toEqual(
          expect.arrayContaining([...expectedReasons]),
        );
      }
      expect(result.rejected.map((finding) => finding.candidateFindingId).sort()).toEqual(
        Object.keys(loadedFixture.fixture.expected.rejected).sort(),
      );

      for (const expectedGroup of loadedFixture.fixture.expected.duplicateGroups ?? []) {
        expect(result.duplicateGroups).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              canonicalCandidateFindingId: expectedGroup.canonicalCandidateFindingId,
              duplicateCandidateFindingIds: expectedGroup.duplicateCandidateFindingIds,
              groupKind: expectedGroup.groupKind,
            }),
          ]),
        );
      }

      expect(publishPlanShapeFromFixture(result.accepted, config)).toEqual(
        loadedFixture.fixture.expected.publishPlan,
      );
    });
  }
});

/** Loads all validation fixture files in stable filename order. */
function loadValidationFixtures(): readonly LoadedValidationFixture[] {
  return readdirSync(validationFixtureDirectory)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => {
      const rawFixture: unknown = JSON.parse(
        readFileSync(path.join(validationFixtureDirectory, fileName), "utf8"),
      );
      return {
        fileName,
        fixture: parseValidationFixture(rawFixture, fileName),
      };
    });
}

/** Parses a fixture and fails fast on the top-level fixture contract. */
function parseValidationFixture(value: unknown, fileName: string): ValidationFixture {
  if (!isRecord(value)) {
    throw new Error(`${fileName} must contain a JSON object.`);
  }
  if (value.schemaVersion !== "finding_validation_fixture.v1") {
    throw new Error(`${fileName} must use finding_validation_fixture.v1.`);
  }
  if (typeof value.name !== "string") {
    throw new Error(`${fileName} must define a fixture name.`);
  }
  if (!isRecord(value.snapshot)) {
    throw new Error(`${fileName} must define a snapshot object.`);
  }
  if (!Array.isArray(value.findings)) {
    throw new Error(`${fileName} must define findings.`);
  }
  if (!isRecord(value.expected)) {
    throw new Error(`${fileName} must define expected output.`);
  }

  return value as ValidationFixture;
}

/** Returns whether a value is a string-keyed object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Builds a validation config from one fixture config fragment. */
function validationConfigFromFixture(
  config: ValidationFixtureConfig | undefined,
): FindingValidationConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    ...(config.contextItemIds
      ? { contextBundle: contextBundleFromFixture(config.contextItemIds) }
      : {}),
    ...(config.enabledCategories ? { enabledCategories: config.enabledCategories } : {}),
    ...(typeof config.maxPublishableFindings === "number"
      ? { maxPublishableFindings: config.maxPublishableFindings }
      : {}),
    ...(config.minimumSeverity ? { minimumSeverity: config.minimumSeverity } : {}),
    ...(config.previousPublishedFindings
      ? {
          previousPublishedFindings: config.previousPublishedFindings.map((finding) => ({
            body: finding.body,
            fingerprint: finding.fingerprint,
            location: {
              ...validCandidateFindingFixture.location,
              ...finding.location,
            },
            title: finding.title,
          })),
        }
      : {}),
    ...(config.policy ? { policy: policyFromFixture(config.policy) } : {}),
    ...(config.repoRules ? { repoRules: config.repoRules } : {}),
    ...(config.memoryFacts
      ? {
          memorySuppression: {
            memoryFacts: config.memoryFacts.map(memoryFactFromFixture),
            orgId: "org_01HXAMPLE",
            repoId: validPullRequestSnapshotFixture.repoId,
          },
        }
      : {}),
  };
}

/** Builds an effective policy from one fixture policy fragment. */
function policyFromFixture(policy: ValidationFixturePolicy): EffectiveReviewPolicy {
  return createPolicyFixture({
    ...(policy.findings ? { findings: policy.findings } : {}),
    ...(policy.publishing ? { publishing: policy.publishing } : {}),
    ...(policy.reviewPolicy ? { reviewPolicy: policy.reviewPolicy } : {}),
  });
}

/** Builds a memory fact from one fixture memory fragment. */
function memoryFactFromFixture(fact: ValidationFixtureMemoryFact): MemoryFact {
  return {
    appliesTo: fact.appliesTo,
    confidence: 0.95,
    content: fact.content ?? "Suppress matching validation fixture findings.",
    createdAt: validCandidateFindingFixture.createdAt,
    id: fact.id,
    kind: "suppression",
    normalizedContent: (fact.content ?? "Suppress matching validation fixture findings.")
      .toLowerCase()
      .trim(),
    orgId: "org_01HXAMPLE",
    priority: 700,
    repoId: validPullRequestSnapshotFixture.repoId,
    scope: {
      level: "repo",
      orgId: "org_01HXAMPLE",
      repoId: validPullRequestSnapshotFixture.repoId,
    },
    sourceKind: "command",
    status: "active",
    trustLevel: "explicit_maintainer",
    updatedAt: validCandidateFindingFixture.createdAt,
  };
}

/** Builds a pull request snapshot from one fixture snapshot fragment. */
function snapshotFromFixture(snapshot: ValidationFixtureSnapshot): PullRequestSnapshot {
  const files =
    snapshot.files ??
    ([
      {
        addedLines: snapshot.addedLines ?? [2],
        path: validChangedFileFixture.path,
      },
    ] satisfies readonly ValidationFixtureChangedFile[]);
  const changedFiles = files.map(changedFileFromFixture);

  return {
    ...validPullRequestSnapshotFixture,
    additions: changedFiles.reduce((sum, file) => sum + file.additions, 0),
    changedFileCount: changedFiles.length,
    changedFiles,
  };
}

/** Builds a changed file from one fixture changed-file fragment. */
function changedFileFromFixture(file: ValidationFixtureChangedFile, index: number): ChangedFile {
  const addedLines = file.addedLines ?? [2];
  const hunkId = `hunk_${index + 1}`;
  const hunk = {
    ...validDiffHunkFixture,
    hunkId,
    lines: addedLines.map((line) => ({
      content: `  validation fixture changed line ${line};`,
      kind: "addition",
      newLine: line,
    })),
    newLines: Math.max(1, ...addedLines),
  } satisfies DiffHunk;

  return {
    ...validChangedFileFixture,
    additions: addedLines.length,
    changes: addedLines.length,
    hunks: [hunk],
    isBinary: file.isBinary ?? false,
    isGenerated: file.isGenerated ?? false,
    isTest: file.isTest ?? false,
    language: file.language ?? validChangedFileFixture.language,
    path: file.path,
    status: file.status ?? "modified",
  };
}

/** Builds a candidate finding from one fixture finding fragment. */
function candidateFindingFromFixture(finding: ValidationFixtureFinding): CandidateFinding {
  const location = {
    ...validCandidateFindingFixture.location,
    ...finding.location,
  };

  return {
    ...validCandidateFindingFixture,
    body: finding.body,
    category: finding.category ?? validCandidateFindingFixture.category,
    confidence: finding.confidence ?? validCandidateFindingFixture.confidence,
    evidence:
      finding.evidence?.map((evidence, index) => ({
        ...baseEvidenceFixture(),
        ...(evidence.contextItemId ? { contextItemId: evidence.contextItemId } : {}),
        ...(typeof evidence.confidence === "number" ? { confidence: evidence.confidence } : {}),
        evidenceId: `ev_${finding.findingId}_${index + 1}`,
        path: location.path,
        range: { endLine: location.line, startLine: location.line },
        summary: evidence.summary,
      })) ?? defaultEvidenceForFinding(finding.findingId, location),
    findingId: finding.findingId,
    fingerprint: finding.fingerprint,
    location,
    severity: finding.severity ?? validCandidateFindingFixture.severity,
    sourceName: finding.sourceName ?? validCandidateFindingFixture.sourceName,
    ...(finding.suggestedFix ? { suggestedFix: finding.suggestedFix } : {}),
    title: finding.title,
  };
}

/** Builds a context-bundle fragment from fixture context item IDs. */
function contextBundleFromFixture(contextItemIds: readonly string[]): Pick<ContextBundle, "items"> {
  return {
    items: contextItemIds.map((contextItemId) => ({
      contextItemId,
      kind: "diff",
      source: "diff",
      priority: 100,
      tokenEstimate: 10,
      provenance: {
        retriever: "fixture",
        reason: "validation fixture",
      },
    })),
  };
}

/** Builds default diff evidence for one candidate location. */
function defaultEvidenceForFinding(
  findingId: string,
  location: CandidateFinding["location"],
): CandidateFinding["evidence"] {
  return [
    {
      ...baseEvidenceFixture(),
      evidenceId: `ev_${findingId}_1`,
      path: location.path,
      range: { endLine: location.line, startLine: location.line },
      summary: `Fixture evidence for ${findingId}.`,
    },
  ];
}

/** Returns the base evidence fixture, failing loudly if shared fixtures change. */
function baseEvidenceFixture(): CandidateFinding["evidence"][number] {
  const [evidence] = validCandidateFindingFixture.evidence;
  if (!evidence) {
    throw new Error("Expected the valid candidate finding fixture to include evidence.");
  }

  return evidence;
}

/** Indexes rejected validation reasons by candidate finding ID. */
function rejectionReasonsByCandidateId(
  findings: readonly ValidatedFinding[],
): Record<string, readonly FindingRejectionReason[]> {
  return Object.fromEntries(
    findings.map((finding) => [finding.candidateFindingId, finding.validation.reasons]),
  );
}

/** Builds the policy-derived publish-plan shape asserted by validation fixtures. */
function publishPlanShapeFromFixture(
  findings: readonly ValidatedFinding[],
  config: FindingValidationConfig | undefined,
): ValidationFixturePublishPlan {
  const policy = config?.policy ?? createPolicyFixture();
  const publishableFindings = findings.slice(
    0,
    Math.max(0, Math.floor(policy.publishing.maxCommentsPerReview)),
  );
  const publishableCandidateIds = publishableFindings.map((finding) => finding.candidateFindingId);

  return {
    checkAnnotationCandidateFindingIds: policy.publishing.publishCheckRun
      ? publishableCandidateIds
      : [],
    inlineCandidateFindingIds: policy.publishing.publishInlineComments
      ? publishableFindings
          .filter((finding) => finding.location.isInDiff !== false)
          .map((finding) => finding.candidateFindingId)
      : [],
    summaryCandidateFindingIds: policy.publishing.publishSummaryComment
      ? publishableCandidateIds
      : [],
  };
}
