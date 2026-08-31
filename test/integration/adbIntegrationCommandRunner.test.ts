import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { executionBoundaryAst } from "../../scripts/lib/executionBoundaryAst";
import type { ExecResult } from "../../src/models";
import type { HostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import { createExecResult } from "../../src/utils/execResult";
import {
  ADB_INTEGRATION_COMMAND_TIMEOUT_MS,
  createAdbIntegrationCommandRunner,
  waitForAdbCondition,
} from "./adbIntegrationCommandRunner";

const FAST_TEST_TIMEOUT_MS = 100;
const ANDROID_H264_INTEGRATION_TEST_PATH = new URL(
  "./androidH264SourceDevice.integration.test.ts",
  import.meta.url,
);

function directAdbExecutionCalls(source: string): string[] {
  const ast = executionBoundaryAst(source);
  return ast.calls
    .filter(
      (call) =>
        (ast.isLauncher(call) || ast.isExecutionSeam(call)) &&
        ast.strings(call.arguments[0]).includes("adb"),
    )
    .map((call) => call.getText());
}

// This fixture is static. Keeping its I/O and AST setup out of the assertion
// body preserves the fast-test budget on cold macOS runners.
const androidH264IntegrationTestSource = readFileSync(ANDROID_H264_INTEGRATION_TEST_PATH, "utf8");
const androidH264DirectAdbExecutionCalls = directAdbExecutionCalls(
  androidH264IntegrationTestSource,
);

describe("createAdbIntegrationCommandRunner", () => {
  test(
    "does not accept a condition that completes after its deadline",
    async () => {
      const now = spyOn(Date, "now");
      now.mockReturnValueOnce(0).mockReturnValueOnce(6);
      try {
        await expect(
          waitForAdbCondition(async () => true, "screenrecord process did not exit after stop", 5),
        ).rejects.toThrow("screenrecord process did not exit after stop within 5ms");
      } finally {
        now.mockRestore();
      }
    },
    FAST_TEST_TIMEOUT_MS,
  );

  test(
    "bounds every query through the host command executor",
    async () => {
      const calls: Array<{ file: string; args: string[]; timeoutMs?: number }> = [];
      const executor: Pick<HostCommandExecutor, "executeCommand"> = {
        async executeCommand(file, args = [], options = {}): Promise<ExecResult> {
          calls.push({ file, args, timeoutMs: options.timeoutMs });
          return createExecResult("output", "");
        },
      };

      const result = await createAdbIntegrationCommandRunner(executor).run(
        ["devices"],
        "discovering an Android device",
      );

      expect(result.stdout).toBe("output");
      expect(calls).toEqual([
        {
          file: "adb",
          args: ["devices"],
          timeoutMs: ADB_INTEGRATION_COMMAND_TIMEOUT_MS,
        },
      ]);
    },
    FAST_TEST_TIMEOUT_MS,
  );

  test(
    "includes the phase, timeout, command, and root error in diagnostics",
    async () => {
      const executor: Pick<HostCommandExecutor, "executeCommand"> = {
        async executeCommand(): Promise<ExecResult> {
          throw new Error("timed out waiting for ADB server");
        },
      };

      await expect(
        createAdbIntegrationCommandRunner(executor).run(
          ["-s", "emulator-5554", "shell", "wm", "size"],
          "reading display size",
        ),
      ).rejects.toThrow(
        `ADB reading display size failed within ${ADB_INTEGRATION_COMMAND_TIMEOUT_MS}ms: adb -s emulator-5554 shell wm size\n` +
          "timed out waiting for ADB server",
      );
    },
    FAST_TEST_TIMEOUT_MS,
  );

  test(
    "rejects direct ADB execution in the on-device suite",
    () => {
      expect(androidH264DirectAdbExecutionCalls).toEqual([]);
      expect(androidH264IntegrationTestSource).toContain("}, ADB_SETUP_HOOK_TIMEOUT_MS)");
    },
    FAST_TEST_TIMEOUT_MS,
  );

  test(
    "detects child-process and host-executor ADB bypasses",
    () => {
      const source = `
        import { execFile } from "node:child_process";
        execFile("adb", ["devices"]);
        executor.executeCommand("adb", ["wait-for-device"]);
      `;

      expect(directAdbExecutionCalls(source)).toEqual([
        'execFile("adb", ["devices"])',
        'executor.executeCommand("adb", ["wait-for-device"])',
      ]);
    },
    FAST_TEST_TIMEOUT_MS,
  );
});
