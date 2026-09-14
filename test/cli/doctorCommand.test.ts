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
  test.each(["yes", 1, 0, "true", null, undefined])(
    "rejects an explicitly malformed repair flag before diagnosis: %s",
    async (repair) => {
      const diagnosis = spyOn(DaemonClient.prototype, "callTool").mockResolvedValue({
        summary: { failed: 0 },
      });
      const close = spyOn(DaemonClient.prototype, "close").mockResolvedValue(undefined);
      let repairCalls = 0;
      setCliOutputSinksForTesting({ stdout: { write: () => {} }, stderr: { write: () => {} } });
      try {
        await expect(
          runDoctorCommand(
            { repair, json: true },
            {
              repairDaemon: async () => {
                repairCalls++;
                return { status: "repaired", phase: "complete", action: "joined" };
              },
            },
          ),
        ).rejects.toThrow("--repair must be a boolean");
        expect(diagnosis).not.toHaveBeenCalled();
        expect(repairCalls).toBe(0);
      } finally {
        diagnosis.mockRestore();
        close.mockRestore();
        resetCliOutputSinksForTesting();
      }
    },
  );

  test.each([{ args: ["doctor"] }, { args: ["doctor", "--repair", "false"] }])(
    "retains ordinary diagnosis for valid non-repair arguments: %s",
    async ({ args }) => {
      const diagnosis = spyOn(DaemonClient.prototype, "callTool").mockResolvedValue({
        summary: { failed: 0 },
      });
      const close = spyOn(DaemonClient.prototype, "close").mockResolvedValue(undefined);
      setCliOutputSinksForTesting({ stdout: { write: () => {} }, stderr: { write: () => {} } });
      try {
        await runDoctorCommand(
          { ...parseCliArgs(args).params, json: true },
          {
            repairDaemon: async () => {
              throw new Error("Unexpected repair");
            },
          },
        );
        expect(diagnosis).toHaveBeenCalledTimes(1);
        expect(diagnosis.mock.calls[0]).toEqual(["doctor", {}]);
      } finally {
        diagnosis.mockRestore();
        close.mockRestore();
        resetCliOutputSinksForTesting();
      }
    },
  );

  test("keeps CLI JSON formatting out of the daemon doctor request", () => {
    expect(doctorToolParams({ ios: true, json: true })).toEqual({ ios: true });
  });

  test("keeps recovery-only flags out of the daemon doctor request", () => {
    expect(
      doctorToolParams({
        android: true,
        repair: true,
        timeoutMs: 12_000,
      }),
    ).toEqual({ android: true });
  });

  test("runs repair locally and renders its structured result", async () => {
    const written: string[] = [];
    let receivedTimeoutMs: number | undefined;
    let receivedDaemonOptions: { host?: string; port?: number } | undefined;
    setCliOutputSinksForTesting({
      stdout: { write: (text) => written.push(text) },
      stderr: { write: () => {} },
    });

    try {
      await runDoctorCommand(
        { repair: true, timeoutMs: 12_000 },
        {
          repairDaemon: async (options) => {
            receivedTimeoutMs = options.timeoutMs;
            receivedDaemonOptions = options.daemonOptions;
            return {
              status: "repaired",
              phase: "complete",
              action: "restarted",
              before: {
                timestamp: "before",
                daemonRunning: false,
                socketExists: false,
                socketAccessible: false,
                pidFileExists: true,
                pidFileValid: false,
                socketConnectable: false,
                recommendations: [],
              },
              after: {
                timestamp: "after",
                daemonRunning: true,
                socketExists: true,
                socketAccessible: true,
                pidFileExists: true,
                pidFileValid: true,
                socketConnectable: true,
                recommendations: [],
              },
            };
          },
        },
        { host: "127.0.0.1", port: 4321 },
      );
    } finally {
      resetCliOutputSinksForTesting();
    }

    expect(receivedTimeoutMs).toBe(12_000);
    expect(receivedDaemonOptions).toEqual({ host: "127.0.0.1", port: 4321 });
    expect(JSON.parse(written[0])).toMatchObject({
      status: "repaired",
      action: "restarted",
      before: { socketConnectable: false },
      after: { socketConnectable: true },
    });
  });

  test("threads Android and iOS filters into host-wide repair's post-repair diagnostics", async () => {
    const receivedOptions: unknown[] = [];
    setCliOutputSinksForTesting({
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    try {
      for (const params of [
        { repair: true, android: true },
        { repair: true, ios: true },
      ]) {
        await runDoctorCommand(params, {
          repairDaemon: async (options) => {
            receivedOptions.push(options);
            return { status: "repaired", phase: "complete", action: "joined" };
          },
        });
      }
    } finally {
      resetCliOutputSinksForTesting();
    }

    expect(receivedOptions).toEqual([
      { timeoutMs: undefined, android: true, ios: undefined, daemonOptions: undefined },
      { timeoutMs: undefined, android: undefined, ios: true, daemonOptions: undefined },
    ]);
  });

  test("forwards malformed repair timeout values for recovery validation", async () => {
    let receivedTimeoutMs: unknown;
    setCliOutputSinksForTesting({
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    try {
      await runDoctorCommand(
        { repair: true, timeoutMs: "not-a-number" },
        {
          repairDaemon: async (options) => {
            receivedTimeoutMs = options.timeoutMs;
            return { status: "repaired", phase: "complete", action: "joined" };
          },
        },
      );
    } finally {
      resetCliOutputSinksForTesting();
    }

    expect(receivedTimeoutMs).toBe("not-a-number");
  });

  test("documents repair-only doctor flags without adding them to the MCP schema", async () => {
    const lines: string[] = [];
    await runCliCommand(["help", "doctor"], undefined, {
      log: (message) => lines.push(message),
      error: () => {},
    });

    const help = lines.join("\n");
    expect(help).toContain("--repair (optional)");
    expect(help).toContain("--timeout-ms (optional)");
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
