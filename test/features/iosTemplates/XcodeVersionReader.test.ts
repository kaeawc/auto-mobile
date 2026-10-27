import { expect, test } from "bun:test";
import { CommandXcodeVersionReader } from "../../../src/features/iosTemplates/XcodeVersionReader";
import { createExecResult } from "../../../src/utils/execResult";
test("reads the Xcode build through the existing exec seam", async () => {
  const signal = new AbortController().signal;
  const reader = new CommandXcodeVersionReader({
    executeCommand: async (args, options) => {
      expect(args).toEqual(["-version"]);
      expect(options?.signal).toBe(signal);
      return createExecResult("Xcode 27.0\nBuild version 27A123\n", "");
    },
  });
  expect(await reader.readBuild(signal)).toBe("27A123");
});
test("missing Xcode build is cached as unknown", async () => {
  const reader = new CommandXcodeVersionReader({
    executeCommand: async () => createExecResult("Xcode 27", ""),
  });
  expect(await reader.readBuild()).toBe("unknown");
});

test("concurrent Xcode reads share one bounded exec", async () => {
  let calls = 0;
  const reader = new CommandXcodeVersionReader({
    executeCommand: async (_args, options) => {
      calls++;
      expect(options?.timeoutMs).toBe(5_000);
      return createExecResult("Build version X1", "");
    },
  });
  expect(await Promise.all([reader.readBuild(), reader.readBuild()])).toEqual(["X1", "X1"]);
  expect(calls).toBe(1);
});
