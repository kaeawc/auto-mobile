import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  handleDoctorResult,
  doctorToolParams,
  runCliCommand,
  parseCliArgs,
  runDoctorCommand,
  resetCliOutputSinksForTesting,
  setCliOutputSinksForTesting,
} from "../../src/cli";
import { CLI_OUTPUT_INLINE_MAX_BYTES } from "../../src/cli/toolOutput";
import { serverConfig } from "../../src/utils/ServerConfig";
import { DaemonClient } from "../../src/daemon/client";

describe("doctorToolParams", () => {
  test("rejects removed doctor flags before diagnosis with supported daemon remedies", async () => {
    const diagnosis = spyOn(DaemonClient.prototype, "callTool");
    try {
      await expect(runDoctorCommand(parseCliArgs(["doctor", "--repair"]).params)).rejects.toThrow(
        "doctor is status-only; --repair and --timeout-ms were removed",
      );
      expect(diagnosis).not.toHaveBeenCalled();

      await expect(
        runDoctorCommand(parseCliArgs(["doctor", "--timeout-ms", "5000"]).params),
      ).rejects.toThrow("doctor is status-only; --repair and --timeout-ms were removed");
      expect(diagnosis).not.toHaveBeenCalled();
    } finally {
      diagnosis.mockRestore();
    }
  });

  test("retains ordinary diagnosis without --repair", async () => {
    const diagnosis = spyOn(DaemonClient.prototype, "callTool").mockResolvedValue({
      summary: { failed: 0 },
    });
    const close = spyOn(DaemonClient.prototype, "close").mockResolvedValue(undefined);
    setCliOutputSinksForTesting({ stdout: { write: () => {} }, stderr: { write: () => {} } });
    try {
      await runDoctorCommand({ ...parseCliArgs(["doctor"]).params, json: true });
      expect(diagnosis).toHaveBeenCalledWith("doctor", {});
    } finally {
      diagnosis.mockRestore();
      close.mockRestore();
      resetCliOutputSinksForTesting();
    }
  });

  test("keeps CLI JSON formatting out of the daemon doctor request", () => {
    expect(doctorToolParams({ ios: true, json: true })).toEqual({ ios: true });
  });

  test("does not document removed repair-only doctor flags", async () => {
    const lines: string[] = [];
    await runCliCommand(["help", "doctor"], undefined, {
      log: (message) => lines.push(message),
      error: () => {},
    });

    const help = lines.join("\n");
    expect(help).not.toContain("--repair");
    expect(help).not.toContain("--timeout-ms");
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
