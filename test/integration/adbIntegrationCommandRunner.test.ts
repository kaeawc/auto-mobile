import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ExecResult } from "../../src/models";
import type { HostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import { createExecResult } from "../../src/utils/execResult";
import {
  ADB_INTEGRATION_COMMAND_TIMEOUT_MS,
  createAdbIntegrationCommandRunner,
} from "./adbIntegrationCommandRunner";

const FAST_TEST_TIMEOUT_MS = 100;
const ANDROID_H264_INTEGRATION_TEST_PATH = new URL(
  "./androidH264SourceDevice.integration.test.ts",
  import.meta.url,
);

describe("createAdbIntegrationCommandRunner", () => {
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
    "routes every short-lived ADB query in the on-device suite through the bounded runner",
    () => {
      const source = readFileSync(ANDROID_H264_INTEGRATION_TEST_PATH, "utf8");

      expect(source).not.toContain("execFileAsync(");
      expect(source.match(/(?:adb|adbRunner)\.run\(/g)).toHaveLength(4);
      expect(source).toContain("}, ADB_SETUP_HOOK_TIMEOUT_MS)");
    },
    FAST_TEST_TIMEOUT_MS,
  );
});
