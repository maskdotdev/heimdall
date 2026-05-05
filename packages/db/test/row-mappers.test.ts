import { describe, expect, it } from "vitest";
import { toRepository } from "../src/repositories/row-mappers";

describe("database row mappers", () => {
  it("validates mapped rows against public contracts", () => {
    expect(() =>
      toRepository({
        repoId: "repo_test",
        orgId: "org_test",
        installationId: "inst_test",
        provider: "not-a-provider",
        providerRepoId: "123",
        owner: "heimdall",
        name: "heimdall",
        fullName: "heimdall/heimdall",
        defaultBranch: "main",
        cloneUrl: "https://example.com/heimdall/heimdall.git",
        visibility: "private",
        isArchived: false,
        isFork: false,
        enabled: true,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        metadata: {},
      }),
    ).toThrow(/Input failed schema validation: Repository/u);
  });
});
