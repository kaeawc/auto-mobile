import { describe, expect, mock, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { runAndroidCommand } from "../../../src/utils/android-cmdline-tools/runAndroidCommand";
import { FakeTimer } from "../../fakes/FakeTimer";

function harness(name: "avdmanager" | "sdkmanager" = "avdmanager") {
  // An inert child with in-memory pipes: no host process is started.
  const child = new ChildProcess();
  Object.defineProperties(child, {
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() },
    stdin: { value: new PassThrough() },
  });
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  child.kill = (signal) => {
    kills.push(signal);
    return true;
  };
  const timer = new FakeTimer();
  const spawn = mock(() => child);
  const onStart = mock(() => {});
  const request = {
    command: name,
    args: ["--version"],
    env: { HOME: "/test-home" },
    timeoutMs: 10,
    maxStdoutChars: 4,
    maxStderrChars: 3,
    name,
    spawnErrorPrefix: `Failed to spawn ${name}: `,
    terminationGraceMs: 20,
    ...(name === "avdmanager" ? { forcedSettlementDelayMs: 20 } : {}),
    onStart,
  };
  return { child, kills, timer, spawn, request, onStart };
}

describe("runAndroidCommand", () => {
  test("uses the host spawn seam and independently bounds both streams", async () => {
    const h = harness();
    const onOutput = mock(() => {});
    const pending = runAndroidCommand(h, { ...h.request, input: "yes\n", onOutput });
    expect(h.spawn).toHaveBeenCalledWith("avdmanager", ["--version"], {
      env: { HOME: "/test-home" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    expect(h.child.stdin?.read()?.toString()).toBe("yes\n");
    expect(h.onStart).toHaveBeenCalledTimes(1);
    h.child.stdout?.emit("data", Buffer.from("12345"));
    h.child.stderr?.emit("data", Buffer.from("abc"));
    h.child.emit("close", 0);
    await expect(pending).resolves.toEqual({
      stdout: "1234",
      stderr: "abc",
      exitCode: 0,
      stdoutTruncated: true,
      stderrTruncated: false,
    });
    expect(onOutput).toHaveBeenCalledWith("stdout", "12345");
    expect(h.timer.getPendingTimeouts()).toEqual([]);
    h.timer.advanceTime(100);
    expect(h.kills).toEqual([]);
  });

  for (const name of ["avdmanager", "sdkmanager"] as const) {
    test(`${name} preserves its forced-settlement deadline`, async () => {
      const h = harness(name);
      let settled = false;
      const pending = runAndroidCommand(h, h.request);
      const rejection = pending.catch((error: Error) => {
        settled = true;
        return error.message;
      });
      h.timer.advanceTime(10);
      expect(h.kills).toEqual(["SIGTERM"]);
      h.timer.advanceTime(20);
      expect(h.kills).toEqual(["SIGTERM", "SIGKILL"]);
      await Promise.resolve();
      expect(settled).toBe(name === "sdkmanager");
      if (name === "avdmanager") {
        h.timer.advanceTime(19);
        await Promise.resolve();
        expect(settled).toBe(false);
        h.timer.advanceTime(1);
      }
      expect(await rejection).toBe(`${name} command timed out after 10ms`);
      expect(h.timer.getPendingTimeouts()).toEqual([]);
    });
  }

  test("pre-abort never spawns or logs", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(runAndroidCommand(h, { ...h.request, signal: controller.signal })).rejects.toThrow(
      "avdmanager command cancelled",
    );
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.onStart).not.toHaveBeenCalled();
  });

  test("abort settles on avdmanager exit and cancels escalation", async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = runAndroidCommand(h, { ...h.request, signal: controller.signal });
    controller.abort();
    h.child.emit("exit", 0);
    await expect(pending).rejects.toThrow("avdmanager command cancelled");
    h.timer.advanceTime(100);
    expect(h.kills).toEqual(["SIGTERM"]);
    expect(h.timer.getPendingTimeouts()).toEqual([]);
  });

  test("maps spawn events using the caller's exact prefix", async () => {
    const h = harness();
    const pending = runAndroidCommand(h, h.request);
    h.child.emit("error", new Error("missing"));
    await expect(pending).rejects.toThrow("Failed to spawn avdmanager: missing");
    expect(h.timer.getPendingTimeouts()).toEqual([]);
  });
});
