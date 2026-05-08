import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Dashboard source root checked by boundary tests. */
const WEB_SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Dashboard app root used for readable relative paths. */
const WEB_APP_DIR = resolve(WEB_SRC_DIR, "..");

/** Dashboard API client file that owns direct browser fetch calls. */
const API_CLIENT_FILE = resolve(WEB_SRC_DIR, "api-client.ts");

/** Dashboard entrypoint that owns the rendered product and operator UI. */
const DASHBOARD_MAIN_FILE = resolve(WEB_SRC_DIR, "main.ts");

/** Source file extensions checked by dashboard boundary tests. */
const SOURCE_FILE_PATTERN = /\.ts$/u;

/** Test source file suffix excluded from production boundary checks. */
const TEST_FILE_PATTERN = /\.test\.ts$/u;

/** Server-only workspace packages that dashboard code must not import directly. */
const SERVER_ONLY_PACKAGE_IMPORTS = [
  "@repo/db",
  "@repo/queue",
  "@repo/repo-sync",
  "@repo/indexer-ts",
  "@repo/index-importer",
  "@repo/embedding",
  "@repo/retrieval",
  "@repo/review-orchestrator",
  "@repo/review-engine",
  "@repo/llm-gateway",
  "@repo/publisher",
  "@repo/sandbox",
  "@repo/tool-runner",
] as const;

/** Production dashboard source file and its contents. */
type DashboardSourceFile = {
  /** Source path relative to the web app root. */
  readonly relativePath: string;
  /** Source text. */
  readonly source: string;
};

/** Reads the dashboard entrypoint source. */
function readDashboardMainSource(): string {
  return readFileSync(DASHBOARD_MAIN_FILE, "utf8");
}

/** Recursively collects production dashboard TypeScript source files. */
function readDashboardSourceFiles(directory = WEB_SRC_DIR): readonly DashboardSourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return readDashboardSourceFiles(entryPath);
    }
    if (
      !entry.isFile() ||
      !SOURCE_FILE_PATTERN.test(entry.name) ||
      TEST_FILE_PATTERN.test(entry.name)
    ) {
      return [];
    }
    return [
      {
        relativePath: relative(WEB_APP_DIR, entryPath),
        source: readFileSync(entryPath, "utf8"),
      },
    ];
  });
}

describe("dashboard source boundaries", () => {
  it("keeps direct fetch calls inside the dashboard API client", () => {
    const violations = readDashboardSourceFiles()
      .filter((file) => resolve(WEB_APP_DIR, file.relativePath) !== API_CLIENT_FILE)
      .filter((file) => file.source.includes("fetch("))
      .map((file) => file.relativePath);

    expect(violations).toEqual([]);
  });

  it("does not import server-only workspace packages", () => {
    const violations = readDashboardSourceFiles().flatMap((file) =>
      SERVER_ONLY_PACKAGE_IMPORTS.filter(
        (packageName) =>
          file.source.includes(`"${packageName}"`) || file.source.includes(`'${packageName}'`),
      ).map((packageName) => `${file.relativePath}: ${packageName}`),
    );

    expect(violations).toEqual([]);
  });

  it("keeps primary MVP views and renderers wired into the dashboard", () => {
    const source = readDashboardMainSource();
    const requiredSnippets = [
      "function renderProductDashboard",
      "function renderProductOrgSwitcher",
      "function renderProductRepositorySettingsPanel",
      "function renderProductReviewDetailPanel",
      "function renderProductFindingList",
      "function renderProductFindingDetail",
      "function renderProductReviewArtifacts",
      "function renderOverviewView",
      "function renderSettingsView",
      "function renderRepositoryRules",
      "function renderUsageView",
      "function renderAuditView",
      "function renderSecurityEventView",
      "function renderInspector",
      "function renderInspectorNotice",
      "function renderEmptyState",
      "data-view=",
      "view.kind",
      'data-action="select-product-org"',
      'data-action="toggle-product-repository"',
      'data-action="save-product-settings"',
      'data-action="preview-product-policy"',
      'saveRuleAction: "save-product-rule"',
      'data-action="open-product-review-detail"',
      'data-action="rerun-product-review"',
      'data-action="select-product-finding"',
      'data-action="set-product-finding-outcome"',
      'data-action="suppress-product-finding-similar"',
      'data-action="load-product-review-artifacts"',
      'data-action="load-product-review-artifact-payload"',
      'data-action="download-product-review-artifact-payload"',
      'data-action="load-usage"',
    ];

    expect(requiredSnippets.filter((snippet) => !source.includes(snippet))).toEqual([]);
  });

  it("keeps dashboard state affordances for loading, empty, error, and dangerous actions", () => {
    const source = readDashboardMainSource();
    const requiredSnippets = [
      "renderProductLoadingState",
      "renderOverviewNotice",
      "renderSettingsNotice",
      "renderUsageNotice",
      "renderInspectorNotice",
      "renderEmptyState",
      "inline-empty",
      "error-line",
      "notice",
      "window.confirm(`Delete repository rule",
      "Confirmation token does not match the current plan.",
      "Cancellation requires a reason.",
      "Enter an access reason before viewing an artifact payload.",
      "Enter an access reason before downloading an artifact payload.",
    ];

    expect(requiredSnippets.filter((snippet) => !source.includes(snippet))).toEqual([]);
  });
});
