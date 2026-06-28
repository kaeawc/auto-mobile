import { describe, expect, test } from "bun:test";
import process from "process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DefaultProcessExecutor } from "../../src/utils/ProcessExecutor";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";

// Real subprocess spawns; shared CI runners can take seconds to fork/exec under load.
const SUBPROCESS_TEST_TIMEOUT_MS = 30_000;

describe("DefaultProcessExecutor", function() {
  const executor = new DefaultProcessExecutor();

  test("exec captures stdout", async function() {
    const result = await executor.exec("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  test("exec ExecResult helpers work", async function() {
    const result = await executor.exec("echo world");
    expect(result.trim()).toBe("world");
    expect(result.toString()).toContain("world");
    expect(result.includes("world")).toBe(true);
    expect(result.includes("nope")).toBe(false);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  test("exec rejects on non-zero exit", async function() {
    await expect(executor.exec("false")).rejects.toThrow();
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  test("exec failure includes stderr and exit code context", async function() {
    const script = "console.error('SQLITE_BUSY: database is locked'); process.exit(7)";
    await expect(executor.exec(`${process.execPath} -e ${JSON.stringify(script)}`)).rejects.toThrow(
      /exit code: 7[\s\S]*stderr:[\s\S]*SQLITE_BUSY: database is locked/
    );
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  test("exec bad cwd preserves raw spawn error", async function() {
    const missingCwd = join(tmpdir(), `auto-mobile-missing-cwd-${Date.now()}`);
    await expect(executor.exec("echo ok", { cwd: missingCwd })).rejects.toThrow(
      /cwd: .*auto-mobile-missing-cwd-[\s\S]*error code: ENOENT[\s\S]*raw error: .*spawn/
    );
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  test("spawn returns a ChildProcess", function() {
    const child = executor.spawn("echo", ["hi"]);
    expect(child).toBeDefined();
    expect(typeof child.pid).toBe("number");
    child.kill();
  });
});

describe("DefaultHostCommandExecutor", function() {
  const executor = new DefaultHostCommandExecutor();

  test("executeCommand captures stdout", async function() {
    const result = await executor.executeCommand("echo", ["hello"]);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  test("executeCommand ExecResult helpers work", async function() {
    const result = await executor.executeCommand("echo", ["world"]);
    expect(result.trim()).toBe("world");
    expect(result.toString()).toContain("world");
    expect(result.includes("world")).toBe(true);
    expect(result.includes("nope")).toBe(false);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  test("executeCommand rejects on non-zero exit", async function() {
    await expect(executor.executeCommand("false")).rejects.toThrow();
  }, SUBPROCESS_TEST_TIMEOUT_MS);

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
  }, SUBPROCESS_TEST_TIMEOUT_MS);

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
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  test("executeCommand bad cwd preserves raw spawn error", async function() {
    const missingCwd = join(tmpdir(), `auto-mobile-missing-host-cwd-${Date.now()}`);
    const failingExecutor = new DefaultHostCommandExecutor(async () => {
      const error = new Error("spawn /bin/sh ENOENT");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    });
    await expect(failingExecutor.executeCommand("echo", ["ok"], { cwd: missingCwd })).rejects.toThrow(
      /cwd: .*auto-mobile-missing-host-cwd-[\s\S]*error code: ENOENT[\s\S]*raw error: .*spawn/
    );
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  test("executeCommand passes multiple args", async function() {
    const result = await executor.executeCommand(process.execPath, ["-e", "console.log('foo bar')"]);
    expect(result.stdout.trim()).toBe("foo bar");
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});
