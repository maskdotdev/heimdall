import {
  parseWithSchema,
  type RepoRule,
  RepoRuleEffectSchema,
  type RepoRuleMatcher,
  RepoRuleMatcherSchema,
  RepoRuleSchema,
  safeParseWithSchema,
  UserIdSchema,
} from "@repo/contracts";
import { and, eq, isNull, or } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import { repoRules } from "../schema";

type RepoRuleRow = typeof repoRules.$inferSelect;

/** Input used when creating a durable repository rule row. */
export type CreateRepoRuleRecordInput = Omit<RepoRule, "createdAt" | "updatedAt"> & {
  /** Creation timestamp for deterministic tests and audit reconstruction. */
  readonly createdAt?: string;
  /** Update timestamp for deterministic tests and audit reconstruction. */
  readonly updatedAt?: string;
};

/** Mutable fields that can change for a durable repository rule row. */
export type UpdateRepoRuleRecordPatch = Partial<
  Pick<
    RepoRule,
    | "description"
    | "effect"
    | "enabled"
    | "instruction"
    | "matcher"
    | "metadata"
    | "name"
    | "priority"
  >
>;

const requireReturnedRow = <T>(row: T | undefined): T => {
  if (!row) {
    throw new Error("Database write did not return a row.");
  }

  return row;
};

/** Query helper for typed repository and organization rules. */
export class RepoRuleRepository {
  /** Creates a repository rule query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Lists organization and repository rules that can affect a repository. */
  public async listEffectiveRules(input: {
    /** Organization ID that owns the repository. */
    readonly orgId: string;
    /** Repository ID being evaluated. */
    readonly repoId: string;
  }): Promise<readonly RepoRule[]> {
    const rows = await this.db
      .select()
      .from(repoRules)
      .where(
        or(
          eq(repoRules.repoId, input.repoId),
          and(eq(repoRules.orgId, input.orgId), isNull(repoRules.repoId)),
        ),
      );

    return rows.map(toRepoRule);
  }

  /** Gets one repository-scoped rule by ID. */
  public async getRepositoryRule(input: {
    /** Repository ID that owns the rule. */
    readonly repoId: string;
    /** Rule ID to read. */
    readonly ruleId: string;
  }): Promise<RepoRule | undefined> {
    const [row] = await this.db
      .select()
      .from(repoRules)
      .where(and(eq(repoRules.repoId, input.repoId), eq(repoRules.repoRuleId, input.ruleId)));

    return row ? toRepoRule(row) : undefined;
  }

  /** Gets one repository or organization rule by ID. */
  public async getRule(ruleId: string): Promise<RepoRule | undefined> {
    const [row] = await this.db.select().from(repoRules).where(eq(repoRules.repoRuleId, ruleId));

    return row ? toRepoRule(row) : undefined;
  }

  /** Creates a repository-scoped or organization-scoped rule. */
  public async createRule(input: CreateRepoRuleRecordInput): Promise<RepoRule> {
    const now = input.createdAt ?? new Date().toISOString();
    const rule = parseWithSchema("RepoRule", RepoRuleSchema, {
      ...input,
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    });
    const [row] = await this.db.insert(repoRules).values(toRepoRuleRowValues(rule)).returning();

    return toRepoRule(requireReturnedRow(row));
  }

  /** Updates one repository-scoped rule and returns the updated rule. */
  public async updateRepositoryRule(input: {
    /** Repository ID that owns the rule. */
    readonly repoId: string;
    /** Rule ID to update. */
    readonly ruleId: string;
    /** Mutable rule fields to change. */
    readonly patch: UpdateRepoRuleRecordPatch;
    /** Update timestamp for deterministic tests and audit reconstruction. */
    readonly updatedAt?: string;
  }): Promise<RepoRule | undefined> {
    const current = await this.getRepositoryRule(input);
    if (!current) {
      return undefined;
    }

    const updated = parseWithSchema("RepoRule", RepoRuleSchema, {
      ...current,
      ...input.patch,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    });
    const [row] = await this.db
      .update(repoRules)
      .set(toRepoRuleRowUpdateValues(updated))
      .where(and(eq(repoRules.repoId, input.repoId), eq(repoRules.repoRuleId, input.ruleId)))
      .returning();

    return row ? toRepoRule(row) : undefined;
  }

  /** Deletes one repository-scoped rule and returns the deleted rule when it existed. */
  public async deleteRepositoryRule(input: {
    /** Repository ID that owns the rule. */
    readonly repoId: string;
    /** Rule ID to delete. */
    readonly ruleId: string;
  }): Promise<RepoRule | undefined> {
    const [row] = await this.db
      .delete(repoRules)
      .where(and(eq(repoRules.repoId, input.repoId), eq(repoRules.repoRuleId, input.ruleId)))
      .returning();

    return row ? toRepoRule(row) : undefined;
  }
}

/** Converts a durable rule row to the typed rule contract. */
export function toRepoRule(row: RepoRuleRow): RepoRule {
  const metadata = objectRecord(row.metadata);
  const matcher = parseMatcher(metadata.matcher) ?? legacyMatcherFromRow(row);
  const effect = parseEffect(metadata.effect) ?? parseEffect(row.ruleType) ?? "context";
  const instruction = stringValue(metadata.instruction) ?? row.body;
  const nestedMetadata = objectRecord(metadata.metadata);

  return parseWithSchema("RepoRule", RepoRuleSchema, {
    ruleId: row.repoRuleId,
    orgId: row.orgId,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    name: stringValue(metadata.name) ?? legacyRuleName(row),
    ...optionalStringField("description", stringValue(metadata.description)),
    effect,
    matcher,
    instruction,
    priority: integerValue(metadata.priority) ?? legacyPriority(effect),
    enabled: row.isEnabled,
    ...optionalStringField("createdByUserId", parseUserId(metadata.createdByUserId)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(nestedMetadata ? { metadata: nestedMetadata } : {}),
  });
}

/** Returns the legacy row scope label for a typed rule. */
export function repoRuleScope(rule: RepoRule): string {
  if (rule.matcher.paths && rule.matcher.paths.length > 0) {
    return "path";
  }
  if (rule.matcher.categories && rule.matcher.categories.length > 0) {
    return "category";
  }
  if (rule.matcher.severities && rule.matcher.severities.length > 0) {
    return "severity";
  }
  if (rule.matcher.authors && rule.matcher.authors.length > 0) {
    return "author";
  }
  if (rule.matcher.labels && rule.matcher.labels.length > 0) {
    return "label";
  }

  return rule.repoId ? "repository" : "organization";
}

/** Returns the legacy row type label for a typed rule. */
export function repoRuleType(rule: RepoRule): string {
  return rule.effect;
}

function toRepoRuleRowValues(rule: RepoRule): typeof repoRules.$inferInsert {
  return {
    repoRuleId: rule.ruleId,
    orgId: rule.orgId,
    repoId: rule.repoId,
    scope: repoRuleScope(rule),
    ruleType: repoRuleType(rule),
    body: rule.instruction,
    isEnabled: rule.enabled,
    metadata: repoRuleMetadata(rule),
    createdAt: new Date(rule.createdAt),
    updatedAt: new Date(rule.updatedAt),
  };
}

function toRepoRuleRowUpdateValues(rule: RepoRule): Partial<typeof repoRules.$inferInsert> {
  return {
    scope: repoRuleScope(rule),
    ruleType: repoRuleType(rule),
    body: rule.instruction,
    isEnabled: rule.enabled,
    metadata: repoRuleMetadata(rule),
    updatedAt: new Date(rule.updatedAt),
  };
}

function repoRuleMetadata(rule: RepoRule): Record<string, unknown> {
  return {
    schemaVersion: "repo_rule_metadata.v1",
    name: rule.name,
    ...(rule.description ? { description: rule.description } : {}),
    effect: rule.effect,
    matcher: rule.matcher,
    instruction: rule.instruction,
    priority: rule.priority,
    ...(rule.createdByUserId ? { createdByUserId: rule.createdByUserId } : {}),
    ...(rule.metadata ? { metadata: rule.metadata } : {}),
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function optionalStringField<Key extends string>(
  key: Key,
  value: string | undefined,
): Record<Key, string> | Record<string, never> {
  return value ? ({ [key]: value } as Record<Key, string>) : {};
}

function parseEffect(value: unknown): RepoRule["effect"] | undefined {
  const parsed = safeParseWithSchema("RepoRuleEffect", RepoRuleEffectSchema, value);
  return parsed.ok ? parsed.value : undefined;
}

function parseMatcher(value: unknown): RepoRuleMatcher | undefined {
  const parsed = safeParseWithSchema("RepoRuleMatcher", RepoRuleMatcherSchema, value);
  return parsed.ok ? parsed.value : undefined;
}

function parseUserId(value: unknown): string | undefined {
  const parsed = safeParseWithSchema("UserId", UserIdSchema, value);
  return parsed.ok ? parsed.value : undefined;
}

function legacyMatcherFromRow(row: RepoRuleRow): RepoRuleMatcher {
  if (row.scope === "path" && row.body.includes("*")) {
    return { paths: [row.body] };
  }

  return {};
}

function legacyRuleName(row: RepoRuleRow): string {
  const prefix = row.isEnabled ? "Enabled" : "Disabled";
  return `${prefix} ${row.scope} ${row.ruleType} rule`;
}

function legacyPriority(effect: RepoRule["effect"]): number {
  return effect === "suppress" ? 100 : 500;
}
