import { expect, test } from "bun:test";
import { fixture, options, parsed } from "./manualTestPrivateDaemon.test";
import { runPrivateDaemonCommand } from "../../scripts/manual-test/private-daemon";
import { derivePrivateDaemonBatch } from "../../scripts/manual-test/privateDaemonEnv";
import { FakeTimer } from "../fakes/FakeTimer";

async function stopFixture() {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  const spec = derivePrivateDaemonBatch(options)[0];
  const timer = new FakeTimer();
  f.deps.timer = timer;
  f.files.set(spec.pidFilePath, '{"pid":123}');
  f.files.set(spec.plainPidFilePath, "123\n");
  const signals: Array<[number, NodeJS.Signals]> = [];
  f.deps.signalPid = (pid, signal) => {
    signals.push([pid, signal]);
  };
  f.deps.isPidAlive = () => true;
  f.deps.requestSocket = async (path, request) => {
    expect(path).toBe(spec.socketPath);
    expect(request).toEqual({ method: "ide/status", timeoutMs: 5000 });
    return {
      success: true,
      result: {
        pid: 123,
        reportedSocketPath: spec.socketPath,
        reportedPidFilePath: spec.pidFilePath,
      },
    };
  };
  return { ...f, spec, timer, signals };
}
function stopArgs(wait = "300") {
  return parsed(["stop", "--batch-dir", options.batchDir, "--daemon", "1", "--wait-ms", wait]);
}

test.each(["missing", "dead"])("stop %s pid is gone without a signal or CLI", async (kind) => {
  const f = await stopFixture();
  if (kind === "missing") {
    f.files.delete(f.spec.pidFilePath);
  }
  f.deps.isPidAlive = () => false;
  expect(await runPrivateDaemonCommand(stopArgs(), f.deps)).toBe(0);
  expect(JSON.parse(f.logs[0])).toEqual({
    name: "P1",
    ...(kind === "dead" ? { pid: 123 } : {}),
    outcome: "gone-before-signal",
    via: "none",
  });
  expect(f.signals).toEqual([]);
  expect(f.launches).toEqual([]);
  expect(f.files.has(f.spec.plainPidFilePath)).toBe(false);
});
test("confirmed stop signals once and polls only in 100ms steps", async () => {
  const f = await stopFixture();
  f.deps.isPidAlive = () => f.timer.now() < 200;
  const promise = runPrivateDaemonCommand(stopArgs(), f.deps);
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await f.timer.advanceTimeAsync(200, async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  });
  expect(await promise).toBe(0);
  expect(f.signals).toEqual([[123, "SIGTERM"]]);
  expect(f.timer.getSleepHistory()).toEqual([100, 100]);
  expect(JSON.parse(f.logs[0])).toMatchObject({
    outcome: "stopped",
    via: "signal",
    identity: "confirmed",
    waitedMs: 200,
  });
  expect(f.launches).toEqual([]);
  expect(f.removes).toEqual([f.spec.plainPidFilePath]);
});
test.each(["0", "250"])("confirmed stop still alive at wait=%s keeps pid.txt", async (wait) => {
  const f = await stopFixture();
  const promise = runPrivateDaemonCommand(stopArgs(wait), f.deps);
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await f.timer.advanceTimeAsync(Number(wait), async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  });
  expect(await promise).toBe(1);
  expect(JSON.parse(f.logs[0])).toMatchObject({ outcome: "still-alive", waitedMs: Number(wait) });
  expect(f.signals).toEqual([[123, "SIGTERM"]]);
  expect(f.files.has(f.spec.plainPidFilePath)).toBe(true);
});
test.each(["pid", "socket", "pidFile", "timeout", "refused"])(
  "unconfirmed %s delegates and judges liveness despite exit code",
  async (reason) => {
    for (const aliveAfter of [false, true]) {
      const f = await stopFixture();
      f.deps.requestSocket = async () => {
        if (reason === "timeout") {
          throw new Error("timed out");
        }
        if (reason === "refused") {
          return { success: false, error: "busy" };
        }
        return {
          success: true,
          result: {
            pid: reason === "pid" ? 456 : 123,
            reportedSocketPath: reason === "socket" ? "/other" : f.spec.socketPath,
            reportedPidFilePath: reason === "pidFile" ? "/other" : f.spec.pidFilePath,
          },
        };
      };
      f.deps.runCommand = async (command, args, env) => {
        f.launches.push({ command, args, env });
        f.deps.isPidAlive = () => aliveAfter;
        return { exitCode: 7 };
      };
      expect(await runPrivateDaemonCommand(stopArgs(), f.deps)).toBe(aliveAfter ? 1 : 0);
      expect(JSON.parse(f.logs[0])).toMatchObject({
        via: "product-cli",
        outcome: aliveAfter ? "still-alive" : "stopped",
        productExitCode: 7,
      });
      expect(f.signals).toEqual([]);
      expect(f.launches[0].args).toEqual([options.serverPath, "--daemon", "stop"]);
      expect(f.files.has(f.spec.plainPidFilePath)).toBe(aliveAfter);
    }
  },
);
test("signal ESRCH is gone-before-signal", async () => {
  const f = await stopFixture();
  f.deps.signalPid = () => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  };
  expect(await runPrivateDaemonCommand(stopArgs(), f.deps)).toBe(0);
  expect(JSON.parse(f.logs[0])).toMatchObject({ outcome: "gone-before-signal", via: "signal" });
});
test.each(["-1", "1.5", "nope", "9007199254740992"])("rejects invalid wait %s", (wait) => {
  expect(() => stopArgs(wait)).toThrow("--wait-ms");
});
test("pure stop-outcome classifier", async () => {
  const { stopOutcome } = await import("../../scripts/manual-test/privateDaemonStop");
  expect(stopOutcome(false, false)).toBe("gone-before-signal");
  expect(stopOutcome(true, false)).toBe("stopped");
  expect(stopOutcome(true, true)).toBe("still-alive");
});
