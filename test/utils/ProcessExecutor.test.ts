import { describe, expect, test } from "bun:test";
import { DefaultProcessExecutor } from "../../src/utils/ProcessExecutor";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";

describe("DefaultProcessExecutor", function () {
  const executor = new DefaultProcessExecutor();

  test("exec captures stdout", async function () {
    const result = await executor.exec("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  test("exec ExecResult helpers work", async function () {
    const result = await executor.exec("echo world");
    expect(result.trim()).toBe("world");
    expect(result.toString()).toContain("world");
    expect(result.includes("world")).toBe(true);
    expect(result.includes("nope")).toBe(false);
  });

  test("exec rejects on non-zero exit", async function () {
    await expect(executor.exec("false")).rejects.toThrow();
  });

  test("spawn returns a ChildProcess", function () {
    const child = executor.spawn("echo", ["hi"]);
    expect(child).toBeDefined();
    expect(typeof child.pid).toBe("number");
    child.kill();
  });
});

describe("DefaultHostCommandExecutor", function () {
  const executor = new DefaultHostCommandExecutor();

  test("executeCommand captures stdout", async function () {
    const result = await executor.executeCommand("echo", ["hello"]);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  test("executeCommand ExecResult helpers work", async function () {
    const result = await executor.executeCommand("echo", ["world"]);
    expect(result.trim()).toBe("world");
    expect(result.toString()).toContain("world");
    expect(result.includes("world")).toBe(true);
    expect(result.includes("nope")).toBe(false);
  });

  test("executeCommand rejects on non-zero exit", async function () {
    await expect(executor.executeCommand("false")).rejects.toThrow();
  });

  test("executeCommand passes multiple args", async function () {
    const result = await executor.executeCommand("/bin/sh", ["-c", "echo foo bar"]);
    expect(result.stdout.trim()).toBe("foo bar");
  });
});
