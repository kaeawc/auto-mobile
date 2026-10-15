import { expect, test } from "bun:test";
import { fixture, options, parsed } from "./manualTestPrivateDaemonFixture";
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

function recordedCrash(f: Awaited<ReturnType<typeof stopFixture>>) {
  f.files.set(
    `${f.spec.dir}/daemon-start.json`,
    JSON.stringify({
      pid: 123,
      socketPath: f.spec.socketPath,
      pidFilePath: f.spec.pidFilePath,
      startIdentity: "start-123",
    }),
  );
  f.deps.processGeneration = { current: () => "start-123", compare: () => "same" };
}
test("crash signals exactly the recorded PID with SIGKILL only and reports its identity", async () => {
  const f = await stopFixture();
  recordedCrash(f);
  let alive = true;
  f.deps.isPidAlive = () => alive;
  f.deps.signalPid = (pid, signal) => {
    f.signals.push([pid, signal]);
    alive = false;
  };
  expect(
    await runPrivateDaemonCommand(
      parsed(["stop", "--batch-dir", options.batchDir, "--daemon", "1", "--crash"]),
      f.deps,
    ),
  ).toBe(0);
  expect(f.signals).toEqual([[123, "SIGKILL"]]);
  expect(f.launches).toEqual([]);
  expect(JSON.parse(f.logs[0])).toMatchObject({
    outcome: "crashed",
    identity: "start-123",
    pid: 123,
  });
});
test.each(["missing", "different", "unknown", "socket", "pidfile", "pid", "missing-paths", "race"])(
  "crash refuses %s identity without signalling or delegating",
  async (kind) => {
    const f = await stopFixture();
    recordedCrash(f);
    if (kind === "missing") {
      f.files.delete(`${f.spec.dir}/daemon-start.json`);
    }
    if (["different", "unknown"].includes(kind)) {
      f.deps.processGeneration = {
        current: () => undefined,
        compare: () => (kind === "different" ? "different" : "unknown"),
      };
    }
    if (kind === "race") {
      let comparisons = 0;
      f.deps.processGeneration = {
        current: () => "start-123",
        compare: () => (++comparisons === 1 ? "same" : "different"),
      };
    }
    if (["socket", "pidfile", "pid", "missing-paths"].includes(kind)) {
      f.deps.requestSocket = async () => ({
        success: true,
        result: {
          pid: kind === "pid" ? 456 : 123,
          ...(kind === "missing-paths"
            ? {}
            : {
                reportedSocketPath: kind === "socket" ? "/other" : f.spec.socketPath,
                reportedPidFilePath: kind === "pidfile" ? "/other" : f.spec.pidFilePath,
              }),
        },
      });
    }
    expect(
      await runPrivateDaemonCommand(
        parsed(["stop", "--batch-dir", options.batchDir, "--daemon", "1", "--crash"]),
        f.deps,
      ),
    ).toBe(2);
    expect(f.logs.join("\n")).toContain("Refusing crash");
    expect(f.signals).toEqual([]);
    expect(f.launches).toEqual([]);
    expect(f.files.has(f.spec.plainPidFilePath)).toBe(true);
  },
);
test.each(["port", "socket", "home"])(
  "crash refuses resident %s namespace before probes or signals",
  async (kind) => {
    const f = await stopFixture();
    recordedCrash(f);
    const path = `${options.batchDir}/batch.json`;
    const manifest = JSON.parse(f.files.get(path)!);
    if (kind === "port") {
      manifest.options.basePort = 3000;
    }
    if (kind === "socket") {
      manifest.options.auxRoot = "/tmp/auto-mobile-daemon-4242.sock";
    }
    if (kind === "home") {
      manifest.options.batchDir = "/home/fake/.auto-mobile/batch";
    }
    f.files.set(path, JSON.stringify(manifest));
    expect(
      await runPrivateDaemonCommand(
        parsed(["stop", "--batch-dir", options.batchDir, "--daemon", "1", "--crash"]),
        f.deps,
      ),
    ).toBe(2);
    expect(f.signals).toEqual([]);
    expect(f.launches).toEqual([]);
  },
);
test("start persists captured daemon identity for subsequent crash fencing", async () => {
  const f = fixture();
  f.deps.processGeneration = { current: (pid) => `start-${pid}`, compare: () => "same" };
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  expect(
    await runPrivateDaemonCommand(
      parsed(["start", "--batch-dir", options.batchDir, "--daemon", "1"]),
      f.deps,
    ),
  ).toBe(0);
  const spec = derivePrivateDaemonBatch(options)[0];
  expect(JSON.parse(f.files.get(`${spec.dir}/daemon-start.json`)!)).toMatchObject({
    pid: 1234,
    startIdentity: "start-1234",
    socketPath: spec.socketPath,
    pidFilePath: spec.pidFilePath,
  });
});

test.each(["missing-start", "recorded-pid", "recorded-socket", "recorded-pidfile"])(
  "crash refuses %s batch evidence",
  async (kind) => {
    const f = await stopFixture();
    recordedCrash(f);
    const path = `${f.spec.dir}/daemon-start.json`;
    const recorded = JSON.parse(f.files.get(path)!);
    if (kind === "missing-start") {
      delete recorded.startIdentity;
    }
    if (kind === "recorded-pid") {
      recorded.pid = 999;
    }
    if (kind === "recorded-socket") {
      recorded.socketPath = "/other";
    }
    if (kind === "recorded-pidfile") {
      recorded.pidFilePath = "/other";
    }
    f.files.set(path, JSON.stringify(recorded));
    expect(
      await runPrivateDaemonCommand(
        parsed(["stop", "--batch-dir", options.batchDir, "--daemon", "1", "--crash"]),
        f.deps,
      ),
    ).toBe(2);
    expect(f.signals).toEqual([]);
    expect(f.launches).toEqual([]);
  },
);

test("PrivateDaemonControl crash and restart use the guarded batch daemon operations", async () => {
  const { createPrivateDaemonControl } =
    await import("../../scripts/manual-test/privateDaemonControl");
  const f = await stopFixture();
  recordedCrash(f);
  let alive = true;
  f.deps.isPidAlive = () => alive;
  f.deps.signalPid = (pid, signal) => {
    f.signals.push([pid, signal]);
    alive = false;
  };
  const control = createPrivateDaemonControl(options.batchDir, f.deps);
  await control.crash();
  expect(f.signals).toEqual([[123, "SIGKILL"]]);
  await control.start();
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0].args.slice(0, 3)).toEqual([options.serverPath, "--daemon", "start"]);
  expect(f.launches[0].env.AUTOMOBILE_DAEMON_SOCKET_PATH).toBe(f.spec.socketPath);
});
