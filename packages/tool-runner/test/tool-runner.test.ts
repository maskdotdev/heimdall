import { describe, expect, it } from "vitest";
import { createFakeToolRunner, redactedDisplayCommand, type ToolCommandSpec } from "../src/index";

const command = {
  args: ["--format", "json"],
  cwd: "/workspace/repo",
  displayCommand: "eslint --token abc123 --format json",
  env: {},
  executable: "eslint",
  filesystemPolicy: "read_only",
  networkPolicy: "none",
} satisfies ToolCommandSpec;

describe("tool runner", () => {
  it("returns deterministic fake output and truncates by byte budget", async () => {
    const runner = createFakeToolRunner([{ executable: "eslint", stdout: "abcdef", exitCode: 0 }]);
    const result = await runner.run({
      command,
      maxOutputBytes: 3,
      planId: "plan_1",
      startedAt: "2026-05-06T00:00:00.000Z",
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "abc",
      stdoutBytes: 3,
      truncated: true,
    });
  });

  it("redacts sensitive display command flags", () => {
    expect(redactedDisplayCommand(command)).toBe("eslint --token <redacted> --format json");
  });
});
