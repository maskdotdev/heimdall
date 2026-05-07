import { desc, eq, type SQL, sql } from "drizzle-orm";
import type { HeimdallDatabase } from "../client";
import {
  evalBaselines,
  evalCaseResults,
  evalCases,
  evalRuns,
  evalSuites,
  evalVariants,
} from "../schema";

const requireReturnedRow = <T>(row: T | undefined): T => {
  if (!row) {
    throw new Error("Database write did not return a row.");
  }

  return row;
};

/** Eval suite row selected from the database. */
export type EvalSuiteRow = typeof evalSuites.$inferSelect;

/** Eval case row selected from the database. */
export type EvalCaseRow = typeof evalCases.$inferSelect;

/** Eval variant row selected from the database. */
export type EvalVariantRow = typeof evalVariants.$inferSelect;

/** Eval run row selected from the database. */
export type EvalRunRow = typeof evalRuns.$inferSelect;

/** Eval case result row selected from the database. */
export type EvalCaseResultRow = typeof evalCaseResults.$inferSelect;

/** Eval baseline row selected from the database. */
export type EvalBaselineRow = typeof evalBaselines.$inferSelect;

/** Complete history write for one evaluation report. */
export type EvalHistoryWrite = {
  /** Suite metadata to upsert before case and run rows. */
  readonly suite: typeof evalSuites.$inferInsert;
  /** Case definitions to upsert before result rows. */
  readonly cases?: readonly (typeof evalCases.$inferInsert)[];
  /** Variant metadata to upsert before the run row. */
  readonly variant: typeof evalVariants.$inferInsert;
  /** Optional baseline variant metadata required when the run references a distinct baseline. */
  readonly baselineVariant?: typeof evalVariants.$inferInsert;
  /** Eval run summary row to upsert. */
  readonly run: typeof evalRuns.$inferInsert;
  /** Per-case result rows to upsert after the run row. */
  readonly caseResults: readonly (typeof evalCaseResults.$inferInsert)[];
  /** Optional active baseline pointer to upsert. */
  readonly baseline?: typeof evalBaselines.$inferInsert;
};

/** Options for listing recent eval runs for one suite. */
export type ListEvalRunsForSuiteInput = {
  /** Suite ID to filter by. */
  readonly evalSuiteId: string;
  /** Maximum rows to return. */
  readonly limit?: number;
};

/** Query helper for evaluation history storage. */
export class EvaluationRepository {
  /** Creates an evaluation history query helper. */
  public constructor(private readonly db: HeimdallDatabase) {}

  /** Persists one complete eval history record in a transaction. */
  public async recordEvalHistory(input: EvalHistoryWrite): Promise<EvalRunRow> {
    return this.db.transaction(async (tx) => {
      const repository = new EvaluationRepository(tx as HeimdallDatabase);
      await repository.upsertEvalSuite(input.suite);
      await repository.upsertEvalVariant(input.variant);

      if (input.baselineVariant) {
        await repository.upsertEvalVariant(input.baselineVariant);
      }

      if (input.cases) {
        await repository.upsertEvalCases(input.cases);
      }

      const run = await repository.upsertEvalRun(input.run);
      await repository.upsertEvalCaseResults(input.caseResults);

      if (input.baseline) {
        await repository.upsertEvalBaseline(input.baseline);
      }

      return run;
    }) as Promise<EvalRunRow>;
  }

  /** Inserts or updates an eval suite row. */
  public async upsertEvalSuite(input: typeof evalSuites.$inferInsert): Promise<EvalSuiteRow> {
    const [row] = await this.db
      .insert(evalSuites)
      .values(input)
      .onConflictDoUpdate({
        target: evalSuites.evalSuiteId,
        set: {
          name: sqlExcluded(evalSuites.name.name),
          description: sqlExcluded(evalSuites.description.name),
          version: sqlExcluded(evalSuites.version.name),
          owner: sqlExcluded(evalSuites.owner.name),
          tags: sqlExcluded(evalSuites.tags.name),
          defaultRunner: sqlExcluded(evalSuites.defaultRunner.name),
          defaultGraders: sqlExcluded(evalSuites.defaultGraders.name),
          thresholds: sqlExcluded(evalSuites.thresholds.name),
          updatedAt: input.updatedAt ?? new Date(),
        },
      })
      .returning();

    return requireReturnedRow(row);
  }

  /** Inserts or updates eval case rows by case ID. */
  public async upsertEvalCases(
    inputs: readonly (typeof evalCases.$inferInsert)[],
  ): Promise<readonly EvalCaseRow[]> {
    if (inputs.length === 0) {
      return [];
    }

    return await this.db
      .insert(evalCases)
      .values([...inputs])
      .onConflictDoUpdate({
        target: evalCases.evalCaseId,
        set: {
          evalSuiteId: sqlExcluded(evalCases.evalSuiteId.name),
          name: sqlExcluded(evalCases.name.name),
          description: sqlExcluded(evalCases.description.name),
          language: sqlExcluded(evalCases.language.name),
          tags: sqlExcluded(evalCases.tags.name),
          source: sqlExcluded(evalCases.source.name),
          privacyLevel: sqlExcluded(evalCases.privacyLevel.name),
          difficulty: sqlExcluded(evalCases.difficulty.name),
          fixture: sqlExcluded(evalCases.fixture.name),
          input: sqlExcluded(evalCases.input.name),
          labels: sqlExcluded(evalCases.labels.name),
          expected: sqlExcluded(evalCases.expected.name),
          active: sqlExcluded(evalCases.active.name),
          updatedAt: new Date(),
        },
      })
      .returning();
  }

  /** Inserts or updates an eval variant row. */
  public async upsertEvalVariant(input: typeof evalVariants.$inferInsert): Promise<EvalVariantRow> {
    const [row] = await this.db
      .insert(evalVariants)
      .values(input)
      .onConflictDoUpdate({
        target: evalVariants.evalVariantId,
        set: {
          name: sqlExcluded(evalVariants.name.name),
          description: sqlExcluded(evalVariants.description.name),
          config: sqlExcluded(evalVariants.config.name),
          gitCommitSha: sqlExcluded(evalVariants.gitCommitSha.name),
          createdBy: sqlExcluded(evalVariants.createdBy.name),
        },
      })
      .returning();

    return requireReturnedRow(row);
  }

  /** Inserts or updates an eval run row. */
  public async upsertEvalRun(input: typeof evalRuns.$inferInsert): Promise<EvalRunRow> {
    const [row] = await this.db
      .insert(evalRuns)
      .values(input)
      .onConflictDoUpdate({
        target: evalRuns.evalRunId,
        set: {
          evalSuiteId: sqlExcluded(evalRuns.evalSuiteId.name),
          evalVariantId: sqlExcluded(evalRuns.evalVariantId.name),
          baselineVariantId: sqlExcluded(evalRuns.baselineVariantId.name),
          status: sqlExcluded(evalRuns.status.name),
          triggeredBy: sqlExcluded(evalRuns.triggeredBy.name),
          environment: sqlExcluded(evalRuns.environment.name),
          gitCommitSha: sqlExcluded(evalRuns.gitCommitSha.name),
          branch: sqlExcluded(evalRuns.branch.name),
          caseCount: sqlExcluded(evalRuns.caseCount.name),
          startedAt: sqlExcluded(evalRuns.startedAt.name),
          completedAt: sqlExcluded(evalRuns.completedAt.name),
          reportUri: sqlExcluded(evalRuns.reportUri.name),
          summary: sqlExcluded(evalRuns.summary.name),
          error: sqlExcluded(evalRuns.error.name),
        },
      })
      .returning();

    return requireReturnedRow(row);
  }

  /** Inserts or updates eval case results by run and case ID. */
  public async upsertEvalCaseResults(
    inputs: readonly (typeof evalCaseResults.$inferInsert)[],
  ): Promise<readonly EvalCaseResultRow[]> {
    if (inputs.length === 0) {
      return [];
    }

    return await this.db
      .insert(evalCaseResults)
      .values([...inputs])
      .onConflictDoUpdate({
        target: [evalCaseResults.evalRunId, evalCaseResults.evalCaseId],
        set: {
          evalCaseResultId: sqlExcluded(evalCaseResults.evalCaseResultId.name),
          status: sqlExcluded(evalCaseResults.status.name),
          scores: sqlExcluded(evalCaseResults.scores.name),
          matchedFindings: sqlExcluded(evalCaseResults.matchedFindings.name),
          unmatchedExpectedFindings: sqlExcluded(evalCaseResults.unmatchedExpectedFindings.name),
          unmatchedGeneratedFindings: sqlExcluded(evalCaseResults.unmatchedGeneratedFindings.name),
          timings: sqlExcluded(evalCaseResults.timings.name),
          costs: sqlExcluded(evalCaseResults.costs.name),
          artifacts: sqlExcluded(evalCaseResults.artifacts.name),
          error: sqlExcluded(evalCaseResults.error.name),
        },
      })
      .returning();
  }

  /** Inserts or updates an active eval baseline pointer. */
  public async upsertEvalBaseline(
    input: typeof evalBaselines.$inferInsert,
  ): Promise<EvalBaselineRow> {
    const [row] = await this.db
      .insert(evalBaselines)
      .values(input)
      .onConflictDoUpdate({
        target: [evalBaselines.evalSuiteId, evalBaselines.baselineVariantId],
        set: {
          evalRunId: sqlExcluded(evalBaselines.evalRunId.name),
          active: sqlExcluded(evalBaselines.active.name),
        },
      })
      .returning();

    return requireReturnedRow(row);
  }

  /** Gets one eval run by ID. */
  public async getEvalRun(evalRunId: string): Promise<EvalRunRow | undefined> {
    const [row] = await this.db.select().from(evalRuns).where(eq(evalRuns.evalRunId, evalRunId));

    return row;
  }

  /** Lists recent eval runs for one suite. */
  public async listEvalRunsForSuite(
    input: ListEvalRunsForSuiteInput,
  ): Promise<readonly EvalRunRow[]> {
    return await this.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.evalSuiteId, input.evalSuiteId))
      .orderBy(desc(evalRuns.startedAt))
      .limit(input.limit ?? 25);
  }

  /** Lists case results for one eval run. */
  public async listEvalCaseResults(evalRunId: string): Promise<readonly EvalCaseResultRow[]> {
    return await this.db
      .select()
      .from(evalCaseResults)
      .where(eq(evalCaseResults.evalRunId, evalRunId));
  }
}

/** Builds a typed `excluded.column_name` reference for upsert setters. */
function sqlExcluded<T = unknown>(columnName: string): SQL<T> {
  return sql.raw(`excluded."${columnName}"`) as SQL<T>;
}
