import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  handleDoctorResult,
  doctorToolParams,
  resetCliOutputSinksForTesting,
  setCliOutputSinksForTesting,
} from "../../src/cli";
import { CLI_OUTPUT_INLINE_MAX_BYTES } from "../../src/cli/toolOutput";
import { serverConfig } from "../../src/utils/ServerConfig";

describe("doctorToolParams", () => {
  test("keeps CLI JSON formatting out of the daemon doctor request", () => {
    expect(doctorToolParams({ ios: true, json: true })).toEqual({ ios: true });
  });

  test("renders a normal doctor report as pretty JSON", async () => {
    const written: string[] = [];
    setCliOutputSinksForTesting({
      stdout: { write: (text) => written.push(text) },
      stderr: { write: () => {} },
    });

    try {
      await handleDoctorResult(
        { summary: { failed: 0 }, checks: [{ name: "node", ok: true }] },
        true,
      );
    } finally {
      resetCliOutputSinksForTesting();
    }

    expect(JSON.parse(written[0])).toEqual({
      summary: { failed: 0 },
      checks: [{ name: "node", ok: true }],
    });
    expect(written[0]).toContain("\n");
  });

  test("spills an oversized JSON doctor report rather than writing cut JSON", async () => {
    const toolOutputsDir = mkdtempSync(path.join(tmpdir(), "automobile-cli-doctor-"));
    const originalToolOutputsDir = serverConfig.getToolOutputsDir();
    const written: string[] = [];
    setCliOutputSinksForTesting({
      stdout: { write: (text) => written.push(text) },
      stderr: { write: () => {} },
    });
    serverConfig.setToolOutputsDir(toolOutputsDir);

    try {
      await handleDoctorResult(
        { summary: { failed: 0 }, details: "x".repeat(CLI_OUTPUT_INLINE_MAX_BYTES + 1_024) },
        true,
      );
      const parsed = JSON.parse(written[0]);
      expect(Buffer.byteLength(written[0], "utf8")).toBeLessThanOrEqual(
        CLI_OUTPUT_INLINE_MAX_BYTES + 1,
      );
      expect(parsed.truncated === false || parsed.truncated === true).toBe(true);
      if (parsed.truncated === false) {
        expect(parsed.artifact.path).toStartWith(toolOutputsDir);
        expect(existsSync(parsed.artifact.path)).toBe(true);
      }
    } finally {
      resetCliOutputSinksForTesting();
      serverConfig.setToolOutputsDir(originalToolOutputsDir);
      rmSync(toolOutputsDir, { recursive: true, force: true });
    }
  });
});
