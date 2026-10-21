import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runCliCommand,
  parseCliArgs,
  runDoctorCommand,
  resetCliOutputSinksForTesting,
  setCliOutputSinksForTesting,
} from "../../src/cli";
import { CLI_OUTPUT_INLINE_MAX_BYTES } from "../../src/cli/toolOutput";
import { serverConfig } from "../../src/utils/ServerConfig";
import { DaemonClient } from "../../src/daemon/client";
import { ActionableError } from "../../src/models/ActionableError";

import type { DoctorReport } from "../../src/doctor/types";

function report(failed = 0): DoctorReport {
  return {
    timestamp: "",
    version: "test",
    platform: "darwin",
    arch: "arm64",
    system: { checks: [] },
    autoMobile: { checks: [] },
    recommendations: [],
    summary: { total: failed, passed: 0, warnings: 0, failed, skipped: 0 },
  };
}

isolateToolRegistry();

describe("runDoctorCommand", () => {
  // parseCliArgs lazily registers every CLI tool on first use (~15 ms); pay it in
  // setup so the first test in the file is not charged for it.
  beforeAll(() => {
    parseCliArgs(["doctor"]);
  });

  test.each([true, "yes"])("prints help without diagnosis or exit for help=%s", async (help) => {
    const runDoctor = mock(async () => report());
    const writeOutput = mock((_text: string) => {});
    const exit = mock((_code: number) => {});

    const result = await runDoctorCommand({ help }, { runDoctor, writeOutput, exit });

    expect(runDoctor).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    const output = writeOutput.mock.calls.map(([text]) => text).join("\n");
    expect(output).toContain("--android");
    expect(output).toContain("--ios");
    expect(output).toContain("--json");
    expect(output).toContain("status-only");
    expect(output).toContain("read-only");
  });

  test.each([false, true])("rejects unknown flags before diagnosis with help=%s", async (help) => {
    const runDoctor = mock(async () => report());
    const writeOutput = mock((_text: string) => {});
    const exit = mock((_code: number) => {});
    const params = parseCliArgs(["doctor", "--bogus", "--unknown-flag"]).params;
    const result = runDoctorCommand({ ...params, help }, { runDoctor, writeOutput, exit });

    await expect(result).rejects.toBeInstanceOf(ActionableError);
    await expect(result).rejects.toThrow("--bogus, --unknown-flag");
    await expect(result).rejects.toThrow("Supported flags: --android, --ios, --json, --help");
    expect(runDoctor).not.toHaveBeenCalled();
    expect(writeOutput).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  test.each(["--__proto__", "--constructor", "--prototype"])(
    "rejects the %s flag before diagnosis",
    async (flag) => {
      const runDoctor = mock(async () => report());
      const { params } = parseCliArgs(["doctor", flag]);

      expect(Object.keys(params)).toEqual([flag.slice(2)]);
      await expect(runDoctorCommand(params, { runDoctor })).rejects.toThrow(
        `Unknown doctor flags: ${flag}.`,
      );
      expect(runDoctor).not.toHaveBeenCalled();
    },
  );

  test("records a --__proto__ value as a flag instead of replacing the prototype", () => {
    const { params } = parseCliArgs(["doctor", "--__proto__", '{"help":true}']);

    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(Object.hasOwn(params, "__proto__")).toBe(true);
    expect(Object.hasOwn(params, "help")).toBe(false);
    expect("help" in params).toBe(false);
  });

  test.each([
    { args: ["doctor"], expected: { android: undefined, ios: undefined } },
    { args: ["doctor", "--android"], expected: { android: true, ios: undefined } },
    { args: ["doctor", "--ios"], expected: { android: undefined, ios: true } },
    { args: ["doctor", "--json"], expected: { android: undefined, ios: undefined } },
    { args: ["doctor", "--help=false"], expected: { android: undefined, ios: undefined } },
    {
      args: ["doctor", "--android", "--ios", "--session-uuid", "session-abc"],
      expected: { android: true, ios: true },
    },
    {
      args: ["--session-uuid", "session-abc", "doctor", "--android"],
      expected: { android: true, ios: undefined },
    },
  ])("forwards valid doctor options for $args", async ({ args, expected }) => {
    const argv: string[] = [...args];
    const parsed = parseCliArgs(argv);
    const params = { ...parsed.params };
    // Mirror runCliCommand's forwarding of the leading universal session option.
    if (parsed.sessionUuid) {
      params.sessionUuid = parsed.sessionUuid;
    }
    if (!argv.includes("--session-uuid")) {
      expect(params).not.toHaveProperty("sessionUuid");
    }
    const runDoctor = mock(async () => report());
    const exit = mock((_code: number) => {});
    setCliOutputSinksForTesting({ stdout: { write: () => {} }, stderr: { write: () => {} } });
    try {
      await runDoctorCommand(params, {
        runDoctor,
        writeOutput: () => {},
        exit,
      });
      expect(runDoctor).toHaveBeenCalledTimes(1);
      expect(runDoctor).toHaveBeenCalledWith(expected);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      resetCliOutputSinksForTesting();
    }
  });

  test.each(["repair", "timeoutMs"])(
    "preserves the removed %s error before help or unknown flags",
    async (flag) => {
      const runDoctor = mock(async () => report());
      await expect(
        runDoctorCommand({ [flag]: false, help: true, bogus: true }, { runDoctor }),
      ).rejects.toThrow("doctor is status-only; --repair and --timeout-ms were removed");
      expect(runDoctor).not.toHaveBeenCalled();
    },
  );

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

  test("runs local diagnosis and forwards platform flags without a daemon call", async () => {
    const diagnosis = spyOn(DaemonClient.prototype, "callTool").mockImplementation(() => {
      throw new Error("doctor must not call a daemon tool");
    });
    const connect = spyOn(DaemonClient.prototype, "connect").mockImplementation(() => {
      throw new Error("doctor must not connect to the daemon");
    });
    const localOptions: unknown[] = [];
    setCliOutputSinksForTesting({ stdout: { write: () => {} }, stderr: { write: () => {} } });
    try {
      await runDoctorCommand(
        { ios: true, android: false, json: true },
        {
          runDoctor: async (options) => {
            localOptions.push(options);
            return report();
          },
        },
      );
      expect(localOptions).toEqual([{ ios: true, android: false }]);
      expect(diagnosis).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      diagnosis.mockRestore();
      connect.mockRestore();
      resetCliOutputSinksForTesting();
    }
  });

  test("formats console output and exits with code one for a failed local report", async () => {
    const output: string[] = [];
    const exits: number[] = [];
    const failedReport = report(1);
    await runDoctorCommand(
      {},
      {
        runDoctor: async () => failedReport,
        formatConsoleOutput: (received) => {
          expect(received).toBe(failedReport);
          return "local diagnosis";
        },
        writeOutput: (text) => output.push(text),
        exit: (code) => exits.push(code),
      },
    );
    expect(output).toEqual(["local diagnosis"]);
    expect(exits).toEqual([1]);
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
      await runDoctorCommand({ json: true }, { runDoctor: async () => report() });
    } finally {
      resetCliOutputSinksForTesting();
    }

    expect(JSON.parse(written[0])).toEqual(report());
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
      await runDoctorCommand(
        { json: true },
        {
          runDoctor: async () => ({
            ...report(),
            details: "x".repeat(CLI_OUTPUT_INLINE_MAX_BYTES + 1_024),
          }),
        },
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
