import { describe, expect, test } from "bun:test";
import { runExecSeam, type ExecSeamOptions, type RawExecOutput } from "../../src/utils/ExecSeam";
import { createExecResult } from "../../src/utils/execResult";
import {
  DefaultHostCommandExecutor,
  type ExecFileAsync,
  type ExecFileWithChild,
} from "../../src/utils/HostCommandExecutor";
import type { ChildProcess } from "child_process";

const FAST_TEST_TIMEOUT_MS = 100;

type NodeExecError = Error & { code?: number; stderr?: string; stdout?: string };

// A stand-in for the raw node execFile rejection SimCtlClient's boot recovery
// inspects: CoreSimulator returns SimError 405 with the device already Booted.
function coreSimulator405Error(): NodeExecError {
  const error = new Error("Command failed: xcrun simctl bootstatus <udid> -b") as NodeExecError;
  error.code = 149;
  error.stderr =
    "Unable to boot device in current state: Booted " +
    "(domain=com.apple.CoreSimulator.SimError, code=405)";
  return error;
}

// The canonical ExecResult factory is the single place exec output is coerced
// (Buffer→string) for both executors; the exec-seam paths delegate to it.
describe("createExecResult (canonical exec-seam coercion)", function () {
  test("passes through string stdout/stderr", function () {
    const result = createExecResult("out", "err");
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  test("coerces Buffer stdout/stderr to strings", function () {
    const result = createExecResult(Buffer.from("buffered-out"), Buffer.from("buffered-err"));
    expect(result.stdout).toBe("buffered-out");
    expect(result.stderr).toBe("buffered-err");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
  });

  test("ExecResult helpers operate on stdout", function () {
    const result = createExecResult("  hello world  \n", "");
    expect(result.trim()).toBe("hello world");
    expect(result.toString()).toBe("  hello world  \n");
    expect(result.includes("world")).toBe(true);
    expect(result.includes("nope")).toBe(false);
  });
});

describe("runExecSeam", function () {
  test(
    "maps request options to node exec option names",
    async function () {
      let seen: ExecSeamOptions | undefined;
      const invoke = async (options: ExecSeamOptions): Promise<RawExecOutput> => {
        seen = options;
        return { stdout: "", stderr: "" };
      };
      await runExecSeam(
        invoke,
        { timeoutMs: 1234, maxBuffer: 42, cwd: "/tmp", killSignal: "SIGKILL" },
        { command: "cmd" },
      );
      expect(seen).toEqual({
        timeout: 1234,
        maxBuffer: 42,
        cwd: "/tmp",
        signal: undefined,
        killSignal: "SIGKILL",
      });
    },
    FAST_TEST_TIMEOUT_MS,
  );

  test(
    "returns a buffer-coerced ExecResult",
    async function () {
      const result = await runExecSeam(
        async () => ({ stdout: Buffer.from("data"), stderr: Buffer.from("") }),
        {},
        { command: "cmd" },
      );
      expect(result.stdout).toBe("data");
      expect(result.trim()).toBe("data");
    },
    FAST_TEST_TIMEOUT_MS,
  );

  test(
    "wraps thrown errors with command context",
    async function () {
      const invoke = async (): Promise<RawExecOutput> => {
        const error = new Error("boom") as NodeJS.ErrnoException & { stderr?: string };
        error.code = 7;
        error.stderr = "detailed stderr";
        throw error;
      };
      await expect(
        runExecSeam(invoke, {}, { command: "tool", args: ["arg"], cwd: "/work" }),
      ).rejects.toThrow(
        /Command failed: tool arg[\s\S]*cwd: \/work[\s\S]*exit code: 7[\s\S]*stderr:[\s\S]*detailed stderr/,
      );
    },
    FAST_TEST_TIMEOUT_MS,
  );

  // The default wrap path returns a fresh Error copying only `.name`, so the raw
  // `.code`/`.stderr` are lost. This pins that loss so the `preserveError`
  // contract below is not silently equivalent (issue #5459).
  test(
    "default path drops the raw error's .code/.stderr",
    async function () {
      const original = coreSimulator405Error();
      let thrown: NodeExecError | undefined;
      try {
        await runExecSeam(
          async () => {
            throw original;
          },
          {},
          { command: "xcrun", args: ["simctl", "bootstatus"] },
        );
      } catch (error) {
        thrown = error as NodeExecError;
      }
      expect(thrown).toBeDefined();
      expect(thrown).not.toBe(original);
      expect(thrown?.code).toBeUndefined();
      expect(thrown?.stderr).toBeUndefined();
    },
    FAST_TEST_TIMEOUT_MS,
  );

  // SimCtlClient's execFile leg opts into `preserveError` so CoreSimulator-405
  // boot recovery can still read the original `.code`/`.stderr` after routing
  // through the shared seam (issue #5459, #3938 / #4092).
  test(
    "preserveError propagates the original error with .code/.stderr intact",
    async function () {
      const original = coreSimulator405Error();
      let thrown: NodeExecError | undefined;
      try {
        await runExecSeam(
          async () => {
            throw original;
          },
          {},
          { command: "xcrun", args: ["simctl", "bootstatus"] },
          { preserveError: true },
        );
      } catch (error) {
        thrown = error as NodeExecError;
      }
      expect(thrown).toBe(original);
      expect(thrown?.code).toBe(149);
      expect(thrown?.stderr).toContain("code=405");
    },
    FAST_TEST_TIMEOUT_MS,
  );
});

describe("argv exec seam", function () {
  test(
    "ExecFileAsync is usable by the argv-first owner",
    async function () {
      const argvSeam: ExecFileAsync = async () => ({ stdout: "argv", stderr: "" });
      const result = await new DefaultHostCommandExecutor(argvSeam).executeCommand("echo", [
        "argv",
      ]);
      expect(result.stdout).toBe("argv");
    },
    FAST_TEST_TIMEOUT_MS,
  );

  test(
    "force-kills a child that ignores SIGTERM within the timeout budget",
    async function () {
      const ignoresSigterm: ExecFileAsync = async (_file, _args, options) => {
        if (options?.killSignal === "SIGKILL") {
          throw new Error("child process was force-killed");
        }
        throw new Error("child ignored SIGTERM and remained running");
      };

      const startedAt = performance.now();
      await expect(
        new DefaultHostCommandExecutor(ignoresSigterm).executeCommand("wedged-tool", [], {
          timeoutMs: 5,
          killSignal: "SIGKILL",
        }),
      ).rejects.toThrow("child process was force-killed");
      expect(performance.now() - startedAt).toBeLessThan(FAST_TEST_TIMEOUT_MS);
    },
    FAST_TEST_TIMEOUT_MS,
  );

  test(
    "trackable command execution shares option mapping and result coercion",
    async function () {
      const child = { kill: () => true } as ChildProcess;
      let seen: ExecSeamOptions | undefined;
      const execWithChild: ExecFileWithChild = (_file, _args, options, callback) => {
        seen = options;
        callback(null, Buffer.from("tracked-out"), Buffer.from("tracked-err"));
        return child;
      };

      const started = new DefaultHostCommandExecutor(
        undefined,
        execWithChild,
      ).executeCommandWithChild("adb", ["shell", "true"], { timeoutMs: 1234, maxBuffer: 42 });

      expect(started.child).toBe(child);
      expect(seen).toEqual({
        timeout: 1234,
        maxBuffer: 42,
        cwd: undefined,
        signal: undefined,
        killSignal: undefined,
      });
      await expect(started.result).resolves.toMatchObject({
        stdout: "tracked-out",
        stderr: "tracked-err",
      });
    },
    FAST_TEST_TIMEOUT_MS,
  );

  test(
    "trackable command execution retains callback output when wrapping errors",
    async function () {
      const child = { kill: () => true } as ChildProcess;
      const execWithChild: ExecFileWithChild = (_file, _args, _options, callback) => {
        const error = new Error("adb failed") as Error & { code?: number };
        error.code = 1;
        callback(error, "callback stdout", "callback stderr");
        return child;
      };

      const started = new DefaultHostCommandExecutor(
        undefined,
        execWithChild,
      ).executeCommandWithChild("adb", ["shell", "true"]);

      await expect(started.result).rejects.toThrow(/callback stdout[\s\S]*callback stderr/);
    },
    FAST_TEST_TIMEOUT_MS,
  );

  test(
    "trackable command execution propagates synchronous startup failures",
    function () {
      const startupError = new Error("The argument contains a NUL byte");
      const execWithChild: ExecFileWithChild = () => {
        throw startupError;
      };

      expect(() =>
        new DefaultHostCommandExecutor(undefined, execWithChild).executeCommandWithChild("adb", [
          "shell",
          "a\0b",
        ]),
      ).toThrow(/Command failed: adb shell a\0b[\s\S]*The argument contains a NUL byte/);
    },
    FAST_TEST_TIMEOUT_MS,
  );
});
