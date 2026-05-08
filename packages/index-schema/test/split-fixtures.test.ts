import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateIndexArtifact } from "../src";
import { readIndexArtifactPath } from "../src/node";

/** Expected validation outcome for one checked-in split artifact fixture. */
type SplitFixtureExpectation = {
  /** Directory name under packages/index-schema/fixtures. */
  readonly fixtureName: string;
  /** Whether the fixture should pass schema-owned validation. */
  readonly valid: boolean;
  /** Error substring expected for an intentionally invalid fixture. */
  readonly expectedError?: string;
};

/** Absolute path to the index-schema fixture catalog. */
const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** Checked-in split artifacts required by Phase #10. */
const splitFixtureExpectations: readonly SplitFixtureExpectation[] = [
  {
    fixtureName: "minimal-valid-artifact",
    valid: true,
  },
  {
    fixtureName: "valid-typescript-artifact",
    valid: true,
  },
  {
    fixtureName: "valid-python-artifact",
    valid: true,
  },
  {
    expectedError: "Expected union value",
    fixtureName: "invalid-unknown-record-type",
    valid: false,
  },
  {
    expectedError: "must not contain current-directory path segments",
    fixtureName: "invalid-bad-path",
    valid: false,
  },
  {
    expectedError: "references missing record",
    fixtureName: "invalid-missing-reference",
    valid: false,
  },
  {
    expectedError: "sha256",
    fixtureName: "invalid-bad-checksum",
    valid: false,
  },
  {
    expectedError: "appears after edge records",
    fixtureName: "invalid-out-of-order-records",
    valid: false,
  },
];

describe("checked-in split artifact fixtures", () => {
  it.each(splitFixtureExpectations)("matches validation expectation for $fixtureName", async ({
    expectedError,
    fixtureName,
    valid,
  }) => {
    const errors = await validationErrorsForSplitFixture(fixtureName);

    if (valid) {
      expect(errors).toEqual([]);
      return;
    }

    if (expectedError === undefined) {
      throw new Error(`Invalid fixture ${fixtureName} must declare an expected error.`);
    }

    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining(expectedError)]));
  });
});

/** Reads and validates a checked-in split fixture while preserving read-time integrity errors. */
async function validationErrorsForSplitFixture(fixtureName: string): Promise<readonly string[]> {
  try {
    return validateIndexArtifact(await readIndexArtifactPath(join(fixturesDirectory, fixtureName)));
  } catch (error) {
    return [errorMessage(error)];
  }
}

/** Converts an unknown thrown value into a stable error message for fixture assertions. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
