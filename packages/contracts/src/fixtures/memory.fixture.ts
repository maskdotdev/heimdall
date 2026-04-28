import type { FindingOutcome } from "#contracts/memory/finding-outcome";
import type { MemoryFact } from "#contracts/memory/memory-fact";
import type { RepoRule } from "#contracts/memory/repo-rule";
import { ids, now } from "./common";

export const validFindingOutcomeFixture = {
  outcomeId: ids.outcomeId,
  findingId: ids.findingId,
  reviewRunId: ids.reviewRunId,
  repoId: ids.repoId,
  outcomeType: "resolved",
  signalSource: "provider_webhook",
  actorLogin: "octocat",
  occurredAt: now,
  confidence: 0.9
} satisfies FindingOutcome;

export const validRepoRuleFixture = {
  ruleId: ids.ruleId,
  orgId: ids.orgId,
  repoId: ids.repoId,
  name: "Suppress generated files",
  description: "Generated files are not reviewed.",
  effect: "suppress",
  matcher: {
    paths: ["**/*.generated.ts"],
    languages: ["typescript"],
    severities: ["low", "medium"]
  },
  instruction: "Do not publish findings for generated files.",
  priority: 100,
  enabled: true,
  createdByUserId: ids.userId,
  createdAt: now,
  updatedAt: now
} satisfies RepoRule;

export const validMemoryFactFixture = {
  memoryFactId: ids.memoryFactId,
  orgId: ids.orgId,
  repoId: ids.repoId,
  kind: "repo_convention",
  subject: "Generated files",
  body: "Files matching **/*.generated.ts are produced by build tools.",
  source: "explicit_rule",
  confidence: 1,
  status: "active",
  createdAt: now,
  updatedAt: now
} satisfies MemoryFact;
