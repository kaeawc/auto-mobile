import { describe, expect, test } from "bun:test";
import {
  runExecSeam,
  type ExecSeamOptions,
  type RawExecOutput,
} from "../../src/utils/ExecSeam";
import { createExecResult } from "../../src/utils/execResult";
import {
  DefaultProcessExecutor,
  type ExecAsync,
} from "../../src/utils/ProcessExecutor";
import {
  DefaultHostCommandExecutor,
  type ExecFileAsync,
} from "../../src/utils/HostCommandExecutor";

const FAST_TEST_TIMEOUT_MS = 100;

// The canonical ExecResult factory is the single place exec output is coerced
// (Buffer→string) for both executors; the exec-seam paths delegate to it.
describe("createExecResult (canonical exec-seam coercion)", function() {
  test("passes through string stdout/stderr", function() {
    const result = createExecResult("out", "err");
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  test("coerces Buffer stdout/stderr to strings", function() {
    const result = createExecResult(Buffer.from("buffered-out"), Buffer.from("buffered-err"));
    expect(result.stdout).toBe("buffered-out");
    expect(result.stderr).toBe("buffered-err");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
  });

  test("ExecResult helpers operate on stdout", function() {
    const result = createExecResult("  hello world  \n", "");
    expect(result.trim()).toBe("hello world");
    expect(result.toString()).toBe("  hello world  \n");
    expect(result.includes("world")).toBe(true);
    expect(result.includes("nope")).toBe(false);
  });
});

describe("runExecSeam", function() {
  test("maps request options to node exec option names", async function() {
    let seen: ExecSeamOptions | undefined;
    const invoke = async (options: ExecSeamOptions): Promise<RawExecOutput> => {
      seen = options;
      return { stdout: "", stderr: "" };
    };
    await runExecSeam(invoke, { timeoutMs: 1234, maxBuffer: 42, cwd: "/tmp" }, { command: "cmd" });
    expect(seen).toEqual({ timeout: 1234, maxBuffer: 42, cwd: "/tmp" });
  }, FAST_TEST_TIMEOUT_MS);

  test("returns a buffer-coerced ExecResult", async function() {
    const result = await runExecSeam(
      async () => ({ stdout: Buffer.from("data"), stderr: Buffer.from("") }),
      {},
      { command: "cmd" }
    );
    expect(result.stdout).toBe("data");
    expect(result.trim()).toBe("data");
  }, FAST_TEST_TIMEOUT_MS);

  test("wraps thrown errors with command context", async function() {
    const invoke = async (): Promise<RawExecOutput> => {
      const error = new Error("boom") as NodeJS.ErrnoException & { stderr?: string };
      error.code = 7;
      error.stderr = "detailed stderr";
      throw error;
    };
    await expect(
      runExecSeam(invoke, {}, { command: "tool", args: ["arg"], cwd: "/work" })
    ).rejects.toThrow(
      /Command failed: tool arg[\s\S]*cwd: \/work[\s\S]*exit code: 7[\s\S]*stderr:[\s\S]*detailed stderr/
    );
  }, FAST_TEST_TIMEOUT_MS);
});

describe("shared exec-seam type", function() {
  // These type aliases must be exported so test helpers can type the injected fake
  // for both sibling executors (resolves the ExecAsync/ExecFileAsync export asymmetry).
  test("ExecAsync and ExecFileAsync are both usable/exported", async function() {
    const shellSeam: ExecAsync = async () => ({ stdout: "shell", stderr: "" });
    const argvSeam: ExecFileAsync = async () => ({ stdout: "argv", stderr: "" });

    const processResult = await new DefaultProcessExecutor(shellSeam).exec("echo shell");
    const hostResult = await new DefaultHostCommandExecutor(argvSeam).executeCommand("echo", ["argv"]);

    expect(processResult.stdout).toBe("shell");
    expect(hostResult.stdout).toBe("argv");
  }, FAST_TEST_TIMEOUT_MS);

  test("both executors produce the identical ExecResult shape from the shared factory", async function() {
    const processResult = await new DefaultProcessExecutor(
      async () => ({ stdout: Buffer.from("same\n"), stderr: "" })
    ).exec("cmd");
    const hostResult = await new DefaultHostCommandExecutor(
      async () => ({ stdout: Buffer.from("same\n"), stderr: "" })
    ).executeCommand("cmd");

    expect(processResult.stdout).toBe(hostResult.stdout);
    expect(processResult.trim()).toBe(hostResult.trim());
    expect(processResult.includes("same")).toBe(hostResult.includes("same"));
    expect(Object.keys(processResult).sort()).toEqual(Object.keys(hostResult).sort());
  }, FAST_TEST_TIMEOUT_MS);
});
