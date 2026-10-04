import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { DaemonClientLike } from "../../src/daemon/client";
import type { IdentityRecoveryIO } from "../../src/daemon/identityRecovery";
import type { DaemonSocketReachabilityLike } from "../../src/daemon/daemonSocketReachability";
import type { PidFileData } from "../../src/daemon/types";
import { readPidFileDataSync } from "../../src/daemon/daemonFiles";
import { FakeDaemonSpawner } from "../fakes/FakeDaemonSpawner";
import {
  FakeDaemonProcessTable,
  namespaceDaemonProcess,
  unmarkedDaemonProcess,
} from "../fakes/FakeDaemonProcessTable";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

class PeerReachability implements DaemonSocketReachabilityLike {
  calls = 0;
  reachable: (call: number) => boolean = () => false;
  async isReachable(): Promise<boolean> {
    return this.reachable(++this.calls);
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "peer-rejoin-unit-"));
  const socketPath = join(dir, "private socket.sock");
  const pidPath = join(dir, "daemon.pid");
  const previousEnv = {
    AUTOMOBILE_DATA_DIR: process.env.AUTOMOBILE_DATA_DIR,
    AUTOMOBILE_LOG_DIR: process.env.AUTOMOBILE_LOG_DIR,
    AUTOMOBILE_LOG_SINK: process.env.AUTOMOBILE_LOG_SINK,
  };
  process.env.AUTOMOBILE_DATA_DIR = dir;
  process.env.AUTOMOBILE_LOG_DIR = join(dir, "logs");
  process.env.AUTOMOBILE_LOG_SINK = "file";
  const timer = new FakeTimer();
  cleanups.push(() => {
    timer.reset();
    rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
  const table = new FakeDaemonProcessTable();
  const spawner = new FakeDaemonSpawner(true);
  spawner.logText = "fatal startup error\nSQLITE_BUSY: database is locked\n";
  spawner.onSpawn = (child) => child.emit("exit", 1, null);
  const reachability = new PeerReachability();
  const identity: IdentityRecoveryIO = {
    socketExists: () => false,
    readRecord: () => readPidFileDataSync(pidPath),
    probe: async () => ({ running: false }),
  };
  let connections = 0;
  const client: DaemonClientLike = {
    connect: async () => {
      connections++;
    },
    close: async () => {},
    callTool: async () => ({}),
    readResource: async () => ({}),
    callDaemonMethod: async () => ({}),
  };
  const manager = new SafeDaemonManager(
    () => client,
    undefined,
    timer,
    join(dir, "daemon.lock"),
    pidPath,
    socketPath,
    table,
    { spawn: (...args) => spawner.spawn(...args) as unknown as ChildProcess },
    undefined,
    () => ({ command: "auto-mobile", args: ["--daemon-mode"] }),
    undefined,
    { next: () => "peer-rejoin-owner" },
    reachability,
    "linux",
    { isPortFree: async () => true },
    undefined,
    async () => true,
    identity,
  );
  return {
    manager,
    table,
    spawner,
    reachability,
    timer,
    socketPath,
    pidPath,
    connections: () => connections,
  };
}

const originalExit =
  /Daemon subprocess exited before becoming ready \(exit code 1\)[\s\S]*SQLITE_BUSY: database is locked/;

function expectNoSignals(h: ReturnType<typeof harness>) {
  expect(h.manager.defaultSignals).toEqual([]);
  expect(h.spawner.process.signals).toEqual([]);
}

function expectNoPending(h: ReturnType<typeof harness>) {
  expect(h.timer.getPendingSleepCount()).toBe(0);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
  expect(h.timer.getPendingIntervalCount()).toBe(0);
}

describe("daemon peer rejoin through injected process discovery", () => {
  test("joins a marked namespace peer after the child's exit with exactly two scans", async () => {
    const h = harness();
    h.table.script = (call) => (call === 1 ? [] : [namespaceDaemonProcess(999999, h.socketPath)]);
    h.reachability.reachable = (call) => {
      if (call === 1) {
        // Rejoin starts only after exit formatting has aborted the launch readiness wait.
        h.timer.enableAutoAdvance();
      }
      return call >= 2;
    };
    await expect(h.manager.start()).resolves.toBe("joined");
    expect(h.table.scanCalls).toBe(2);
    expect(h.table.scanTimeouts).toHaveLength(2);
    for (const timeout of h.table.scanTimeouts) {
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(5000);
    }
    expect(h.reachability.calls).toBe(2);
    expectNoSignals(h);
  });

  test("joins a marked namespace peer with exactly two scans despite delayed exit formatting", async () => {
    const h = harness();
    h.table.script = (call) => (call === 1 ? [] : [namespaceDaemonProcess(999999, h.socketPath)]);
    h.reachability.reachable = (call) => {
      if (call === 1) {
        h.timer.enableAutoAdvance();
      }
      return call >= 2;
    };
    // Delay exit formatting on a separate clock from the readiness deadline.
    const formattingTimer = new FakeTimer();
    formattingTimer.enableAutoAdvance();
    const formatExitFailure = h.manager["createDaemonExitFailure"];
    h.manager["createDaemonExitFailure"] = async (...args) => {
      await formattingTimer.sleep(20);
      return formatExitFailure.call(h.manager, ...args);
    };
    try {
      await expect(h.manager.start()).resolves.toBe("joined");
      expect(formattingTimer.getSleepHistory()).toEqual([20]);
    } finally {
      formattingTimer.reset();
      h.manager["createDaemonExitFailure"] = formatExitFailure;
    }
    expect(h.table.scanCalls).toBe(2);
    expect(h.table.scanTimeouts).toHaveLength(2);
    for (const timeout of h.table.scanTimeouts) {
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(5000);
    }
    expect(h.reachability.calls).toBe(2);
    expectNoSignals(h);
  });

  test("socket-first rejoin answers before another scan, with one scan total", async () => {
    const h = harness();
    h.reachability.reachable = () => true;
    await expect(h.manager.start()).resolves.toBe("joined");
    expect(h.table.scanCalls).toBe(1);
    expect(h.reachability.calls).toBe(1);
    expectNoSignals(h);
    expectNoPending(h);
  });

  test("unmarked and other-namespace live daemons are ignored without waiting or signalling", async () => {
    const h = harness();
    h.table.script = () => [
      unmarkedDaemonProcess(424242),
      namespaceDaemonProcess(424243, join(h.socketPath, "other.sock")),
    ];
    await expect(h.manager.start()).rejects.toThrow(originalExit);
    expect(h.table.scanCalls).toBe(2);
    expect(h.reachability.calls).toBe(2);
    expect(h.timer.now()).toBeLessThan(1000);
    expect(h.table.isProcessRunning(424242)).toBe(true);
    expect(h.table.isProcessRunning(424243)).toBe(true);
    expectNoSignals(h);
    expectNoPending(h);
  });

  test("a recovery scan failure preserves the original spawn-exit diagnostic", async () => {
    const h = harness();
    h.table.script = (call) => {
      if (call === 1) {
        return [];
      }
      throw new Error("ps exploded");
    };
    const message = await h.manager.start().then(
      () => {
        throw new Error("start should have rejected");
      },
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(message).toMatch(originalExit);
    expect(message).not.toContain("ps exploded");
    expect(message).not.toContain("Failed to inspect daemon process table");
    expect(h.table.scanCalls).toBe(2);
    expectNoSignals(h);
    expectNoPending(h);
  });

  test.each([false, true])(
    "own child readiness needs no process-table attribution (unmarked=%s)",
    async (unmarked) => {
      const h = harness();
      h.table.livePids.add(h.spawner.process.pid);
      h.table.script = () => (unmarked ? [unmarkedDaemonProcess(h.spawner.process.pid)] : []);
      h.spawner.onSpawn = (child) => {
        const record: PidFileData = {
          pid: child.pid,
          socketPath: h.socketPath,
          port: 3000,
          startedAt: 1,
          version: "test",
        };
        writeFileSync(h.pidPath, JSON.stringify(record));
        writeFileSync(h.socketPath, "fake socket placeholder");
      };
      // Force launchAndWait's exact-child final readiness check, rather than bypassing it
      // with an already-successful waitForReady result. All status and client I/O is real
      // manager logic using the temp PID record and injected client.
      const ready = spyOn(h.manager, "waitForReady").mockImplementation(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return false;
      });
      try {
        await expect(h.manager.start()).resolves.toBe("started");
      } finally {
        ready.mockRestore();
      }
      expect(h.connections()).toBe(1);
      expect(h.table.scanCalls).toBe(1);
      expect(h.table.records).toEqual(
        unmarked ? [unmarkedDaemonProcess(h.spawner.process.pid)] : [],
      );
      await expect(h.manager.waitForReady(100)).resolves.toBe(true);
      expect(h.connections()).toBe(2);
      expectNoSignals(h);
      expectNoPending(h);
    },
  );
});
