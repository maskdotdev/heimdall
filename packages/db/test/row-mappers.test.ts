import { validOrgSettingsFixture } from "@repo/contracts/fixtures/repository.fixture";
import { describe, expect, it } from "vitest";
import { toRepoRule } from "../src/repositories/repo-rule-repository";
import { toOrgSettings, toRepository } from "../src/repositories/row-mappers";

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

  it("maps durable repo rule rows into typed policy rules", () => {
    const rule = toRepoRule({
      repoRuleId: "rule_generated",
      orgId: "org_test",
      repoId: "repo_test",
      scope: "path",
      ruleType: "suppress",
      body: "Do not publish generated-file findings.",
      isEnabled: true,
      metadata: {
        name: "Suppress generated files",
        effect: "suppress",
        matcher: { paths: ["src/generated/**"] },
        instruction: "Do not publish generated-file findings.",
        priority: 100,
      },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(rule).toMatchObject({
      ruleId: "rule_generated",
      effect: "suppress",
      matcher: { paths: ["src/generated/**"] },
      priority: 100,
      enabled: true,
    });
  });

  it("maps organization settings rows into typed policy defaults", () => {
    const row = toOrgSettings({
      orgId: validOrgSettingsFixture.orgId,
      settingsJson: {
        schemaVersion: validOrgSettingsFixture.schemaVersion,
        defaultReviewPolicy: validOrgSettingsFixture.defaultReviewPolicy,
        defaultTriggerPolicy: validOrgSettingsFixture.defaultTriggerPolicy,
        defaultFindingPolicy: validOrgSettingsFixture.defaultFindingPolicy,
        defaultPublishingPolicy: validOrgSettingsFixture.defaultPublishingPolicy,
        defaultMemoryPolicy: validOrgSettingsFixture.defaultMemoryPolicy,
        allowRepoLocalConfig: validOrgSettingsFixture.allowRepoLocalConfig,
        allowMemorySuppression: validOrgSettingsFixture.allowMemorySuppression,
        allowUserDefinedRules: validOrgSettingsFixture.allowUserDefinedRules,
      },
      version: validOrgSettingsFixture.version,
      updatedByUserId: validOrgSettingsFixture.updatedByUserId,
      createdAt: new Date(validOrgSettingsFixture.createdAt),
      updatedAt: new Date(validOrgSettingsFixture.updatedAt),
    });

    expect(row).toEqual(validOrgSettingsFixture);
  });
});
