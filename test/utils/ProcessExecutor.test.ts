import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DefaultProcessExecutor,
  shellCommandForPlatform,
  type ExecAsync,
} from "../../src/utils/ProcessExecutor";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";

// The bulk of these assertions inject a fake exec seam so they never spawn a real
// subprocess — real forks stall past a 30s timeout on contended CI runners (#2914).
// A single retry-tolerant smoke test (bottom of the file) still exercises a real spawn.
// The injected seams complete in under 1ms, but a 100ms deadline flakes when the
// full parallel suite pauses this worker. Keep a short bound without coupling
// correctness to CI scheduler latency.
const FAST_TEST_TIMEOUT_MS = 1_000;
// Real subprocess smoke test only; forking under CI load can take seconds.
const SMOKE_TEST_TIMEOUT_MS = 30_000;

/** Build a fake ExecAsync that resolves with the given stdout/stderr. */
function fakeExecOk(stdout: string, stderr = ""): ExecAsync {
  return async () => ({ stdout, stderr });
}

/** Build a fake ExecAsync that rejects with a Node-style exec error. */
function fakeExecError(overrides: {
  message?: string;
  code?: number | string;
  stderr?: string;
  signal?: NodeJS.Signals;
}): ExecAsync {
  return async () => {
    const error = new Error(overrides.message ?? "Command failed") as NodeJS.ErrnoException & {
      stderr?: string;
      signal?: NodeJS.Signals;
    };
    if (overrides.code !== undefined) {
      (error as unknown as { code: number | string }).code = overrides.code;
    }
    if (overrides.stderr !== undefined) {
      error.stderr = overrides.stderr;
    }
    if (overrides.signal !== undefined) {
      error.signal = overrides.signal;
    }
    throw error;
  };
}

describe("shellCommandForPlatform", function() {
  test("selects the platform shell argv", function() {
    expect(shellCommandForPlatform("echo hello", "win32")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", "echo hello"],
    });
    expect(shellCommandForPlatform("echo hello", "darwin")).toEqual({
      file: "/bin/sh",
      args: ["-c", "echo hello"],
    });
  });
});

describe("DefaultProcessExecutor (injected exec seam)", function() {
  test("exec captures stdout", async function() {
    const executor = new DefaultProcessExecutor(fakeExecOk("hello\n"));
    const result = await executor.exec("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  }, FAST_TEST_TIMEOUT_MS);

  test("exec ExecResult helpers work", async function() {
    const executor = new DefaultProcessExecutor(fakeExecOk("world\n"));
    const result = await executor.exec("echo world");
    expect(result.trim()).toBe("world");
    expect(result.toString()).toContain("world");
    expect(result.includes("world")).toBe(true);
    expect(result.includes("nope")).toBe(false);
  }, FAST_TEST_TIMEOUT_MS);

  test("exec surfaces Buffer stdout/stderr as strings", async function() {
    const executor = new DefaultProcessExecutor(async () => ({
      stdout: Buffer.from("buffered-out"),
      stderr: Buffer.from("buffered-err"),
    }));
    const result = await executor.exec("cmd");
    expect(result.stdout).toBe("buffered-out");
    expect(result.stderr).toBe("buffered-err");
    expect(result.trim()).toBe("buffered-out");
  }, FAST_TEST_TIMEOUT_MS);

  test("exec rejects on non-zero exit", async function() {
    const executor = new DefaultProcessExecutor(fakeExecError({ code: 1 }));
    await expect(executor.exec("false")).rejects.toThrow();
  }, FAST_TEST_TIMEOUT_MS);

  test("exec failure includes stderr and exit code context", async function() {
    const executor = new DefaultProcessExecutor(fakeExecError({
      message: "Command failed",
      code: 7,
      stderr: "SQLITE_BUSY: database is locked",
    }));
    await expect(executor.exec("busy-command")).rejects.toThrow(
      /exit code: 7[\s\S]*stderr:[\s\S]*SQLITE_BUSY: database is locked/
    );
  }, FAST_TEST_TIMEOUT_MS);

  test("exec bad cwd preserves raw spawn error", async function() {
    const missingCwd = join(tmpdir(), "auto-mobile-missing-cwd-fake");
    const executor = new DefaultProcessExecutor(fakeExecError({
      message: "spawn /bin/sh ENOENT",
      code: "ENOENT",
    }));
    await expect(executor.exec("echo ok", { cwd: missingCwd })).rejects.toThrow(
      /cwd: .*auto-mobile-missing-cwd-fake[\s\S]*error code: ENOENT[\s\S]*raw error: .*spawn/
    );
  }, FAST_TEST_TIMEOUT_MS);

  test("exec passes options through to the exec seam", async function() {
    let seen: unknown;
    const executor = new DefaultProcessExecutor(async (_command, options) => {
      seen = options;
      return { stdout: "", stderr: "" };
    });
    await executor.exec("echo hi", { timeoutMs: 1234, maxBuffer: 42, cwd: "/tmp" });
    expect(seen).toEqual({ timeout: 1234, maxBuffer: 42, cwd: "/tmp" });
  }, FAST_TEST_TIMEOUT_MS);
});

describe("DefaultHostCommandExecutor (injected exec seam)", function() {
  test("executeCommand captures stdout", async function() {
    const executor = new DefaultHostCommandExecutor(async () => ({ stdout: "hello\n", stderr: "" }));
    const result = await executor.executeCommand("echo", ["hello"]);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  }, FAST_TEST_TIMEOUT_MS);

  test("executeCommand ExecResult helpers work", async function() {
    const executor = new DefaultHostCommandExecutor(async () => ({ stdout: "world\n", stderr: "" }));
    const result = await executor.executeCommand("echo", ["world"]);
    expect(result.trim()).toBe("world");
    expect(result.toString()).toContain("world");
    expect(result.includes("world")).toBe(true);
    expect(result.includes("nope")).toBe(false);
  }, FAST_TEST_TIMEOUT_MS);

  test("executeCommand rejects on non-zero exit", async function() {
    const executor = new DefaultHostCommandExecutor(async () => {
      const error = new Error("Command failed");
      (error as unknown as { code: number }).code = 1;
      throw error;
    });
    await expect(executor.executeCommand("false")).rejects.toThrow();
  }, FAST_TEST_TIMEOUT_MS);

  test("executeCommand failure includes stderr and exit code context", async function() {
    const failingExecutor = new DefaultHostCommandExecutor(async () => {
      const error = new Error("Command failed");
      (error as unknown as { code: number }).code = 9;
      (error as NodeJS.ErrnoException & { stderr: string }).stderr = "fork ENOENT detail";
      throw error;
    });
    await expect(failingExecutor.executeCommand("tool", ["arg"])).rejects.toThrow(
      /exit code: 9[\s\S]*stderr:[\s\S]*fork ENOENT detail/
    );
  }, FAST_TEST_TIMEOUT_MS);

  test("executeCommand bounds raw error text before appending stderr", async function() {
    const failingExecutor = new DefaultHostCommandExecutor(async () => {
      const error = new Error(`RAW_START ${"x".repeat(5000)} RAW_TAIL`);
      (error as unknown as { code: number }).code = 9;
      (error as NodeJS.ErrnoException & { stderr: string }).stderr = "stderr detail";
      throw error;
    });
    try {
      await failingExecutor.executeCommand("tool", ["arg"]);
      expect.unreachable("executeCommand should fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("RAW_START");
      expect(message).toContain("RAW_TAIL");
      expect(message).toContain("stderr detail");
    }
  }, FAST_TEST_TIMEOUT_MS);

  test("executeCommand bad cwd preserves raw spawn error", async function() {
    const missingCwd = join(tmpdir(), "auto-mobile-missing-host-cwd-fake");
    const failingExecutor = new DefaultHostCommandExecutor(async () => {
      const error = new Error("spawn /bin/sh ENOENT");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    });
    await expect(failingExecutor.executeCommand("echo", ["ok"], { cwd: missingCwd })).rejects.toThrow(
      /cwd: .*auto-mobile-missing-host-cwd-fake[\s\S]*error code: ENOENT[\s\S]*raw error: .*spawn/
    );
  }, FAST_TEST_TIMEOUT_MS);

  test("executeCommand passes multiple args to the exec seam", async function() {
    let seenArgs: string[] | undefined;
    const executor = new DefaultHostCommandExecutor(async (_file, args) => {
      seenArgs = args;
      return { stdout: "foo bar", stderr: "" };
    });
    const result = await executor.executeCommand("node", ["-e", "console.log('foo bar')"]);
    expect(seenArgs).toEqual(["-e", "console.log('foo bar')"]);
    expect(result.stdout.trim()).toBe("foo bar");
  }, FAST_TEST_TIMEOUT_MS);
});

/**
 * Retry a real-subprocess assertion a few times so a single stalled fork/exec on a
 * contended CI runner does not fail the job (#2914). Each attempt is bounded; on the
 * final attempt the error propagates so a genuine regression still fails loudly.
 */
async function withSubprocessRetry(fn: () => Promise<void>, attempts = 3): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("DefaultProcessExecutor real-subprocess smoke test", function() {
  test("round-trips a real echo through exec and spawn", async function() {
    const executor = new DefaultProcessExecutor();
    await withSubprocessRetry(async () => {
      // Keep each attempt well under SMOKE_TEST_TIMEOUT_MS so 3 retries plus the
      // synchronous spawn assertion stay comfortably inside the 30s test budget (#2914).
      const result = await executor.exec("echo hello", { timeoutMs: 4_000 });
      expect(result.stdout.trim()).toBe("hello");

      const child = executor.spawn("echo", ["hi"]);
      expect(child).toBeDefined();
      expect(typeof child.pid).toBe("number");
      child.kill();
    });
  }, SMOKE_TEST_TIMEOUT_MS);
});
