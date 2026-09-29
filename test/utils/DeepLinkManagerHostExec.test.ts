import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { createDefaultHostExec } from "../../src/utils/DeepLinkManager";
import {
  DefaultHostCommandExecutor,
  type ExecFileWithChild,
} from "../../src/utils/HostCommandExecutor";

describe("DeepLinkManager default host exec", () => {
  test("passes argv and maxBuffer through the seam and closes stdin", async () => {
    const writes: string[] = [];
    const calls: Array<{ file: string; args: string[]; maxBuffer?: number }> = [];
    const fakeExec: ExecFileWithChild = (file, args, options, callback) => {
      calls.push({ file, args, maxBuffer: options?.maxBuffer });
      queueMicrotask(() => callback(null, Buffer.from("out"), Buffer.from("err")));
      return { stdin: { end: (value: string) => writes.push(value) } } as unknown as ChildProcess;
    };
    const executor = new DefaultHostCommandExecutor(
      async () => ({ stdout: "", stderr: "" }),
      fakeExec,
    );

    const result = await createDefaultHostExec(executor)("tool", ["literal arg"], "input");

    expect(calls).toEqual([{ file: "tool", args: ["literal arg"], maxBuffer: 16 * 1024 * 1024 }]);
    expect(writes).toEqual(["input"]);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.toString()).toBe("out");
  });

  test("propagates the raw callback error", async () => {
    const rawError = Object.assign(new Error("command failed"), { code: 7 });
    const fakeExec: ExecFileWithChild = (_file, _args, _options, callback) => {
      queueMicrotask(() => callback(rawError, "", "failure"));
      return { stdin: null } as ChildProcess;
    };
    const executor = new DefaultHostCommandExecutor(
      async () => ({ stdout: "", stderr: "" }),
      fakeExec,
    );

    await expect(createDefaultHostExec(executor)("tool", ["bad"])).rejects.toBe(rawError);
  });

  test("propagates a raw startup error", async () => {
    const rawError = new Error("invalid argv");
    const fakeExec: ExecFileWithChild = () => {
      throw rawError;
    };
    const executor = new DefaultHostCommandExecutor(
      async () => ({ stdout: "", stderr: "" }),
      fakeExec,
    );

    await expect(createDefaultHostExec(executor)("tool", ["bad"])).rejects.toBe(rawError);
  });
});
