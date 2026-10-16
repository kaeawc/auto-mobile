import { describe, expect, test } from "bun:test";
import { resolveExecuteCommandOptions } from "../../../src/utils/android-cmdline-tools/executeCommandArgs";

describe("resolveExecuteCommandOptions", () => {
  test("returns an options object unchanged, including streaming and dispatch hooks", () => {
    const onStdout = () => {};
    const options = { timeoutMs: 5, noRetry: true, onStdout, logLabel: "typing" };
    expect(resolveExecuteCommandOptions(options)).toBe(options);
  });

  test("maps the deprecated positional form onto the same fields", () => {
    const signal = new AbortController().signal;
    const onStdout = () => {};
    expect(resolveExecuteCommandOptions(10, 20, true, signal, true, onStdout)).toEqual({
      timeoutMs: 10,
      maxBuffer: 20,
      noRetry: true,
      signal,
      waitForProcessSettlementAfterAbort: true,
      onStdout,
    });
  });

  test("an absent second argument yields an all-undefined options object", () => {
    expect(resolveExecuteCommandOptions().timeoutMs).toBeUndefined();
  });
});
