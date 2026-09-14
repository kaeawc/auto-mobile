import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonManager,
  type DaemonProcessFinder,
  type DaemonProcessLivenessChecker,
  type DaemonProcessRecord,
  type DaemonProcessSignaler,
} from "../../src/daemon/manager";
import { repairDaemon, waitForDaemonRecoveryCompletion } from "../../src/doctor/daemonRecovery";
import { FakeTimer } from "../fakes/FakeTimer";

class MutableDaemonProcesses implements DaemonProcessFinder, DaemonProcessLivenessChecker {
  constructor(
    private readonly records: DaemonProcessRecord[],
    readonly livePids: Set<number>,
  ) {}

  findDaemonProcesses(): DaemonProcessRecord[] {
    return this.records;
  }

  isProcessRunning(pid: number): boolean {
    return this.livePids.has(pid);
  }
}

describe("DaemonManager control-state recovery", () => {
  const tempDirs: string[] = [];
  let originalDataDir: string | undefined;

  function paths(): { lock: string; pid: string; socket: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-recovery-"));
    tempDirs.push(dir);
    originalDataDir ??= process.env.AUTOMOBILE_DATA_DIR;
    process.env.AUTOMOBILE_DATA_DIR = dir;
    return {
      lock: join(dir, "daemon.lock"),
      pid: join(dir, "daemon.pid"),
      socket: join(dir, "daemon.sock"),
    };
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    if (originalDataDir === undefined) {
      delete process.env.AUTOMOBILE_DATA_DIR;
    } else {
      process.env.AUTOMOBILE_DATA_DIR = originalDataDir;
    }
    originalDataDir = undefined;
  });

  test("joins a healthy successor found after acquiring the lifecycle lock", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    const livePids = new Set([1234]);
    const processes = new MutableDaemonProcesses(
      [{ pid: 1234, ppid: 1, command: "bun /worktree/dist/src/index.js --daemon-mode" }],
      livePids,
    );
    let signals = 0;
    const signaler: DaemonProcessSignaler = {
      signal: () => {
        signals++;
      },
    };
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      processes,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => true,
    );

    await expect(manager.recoverControlState()).resolves.toBe("joined");
    expect(signals).toBe(0);
  });

  test("does not take over a released lock after the doctor recovery deadline", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    let lockHeld = true;
    let lockAttempts = 0;
    let spawnCalls = 0;
    let releaseHolder: (() => void) | undefined;
    let waitSignal: AbortSignal | undefined;
    let resolveWaitStarted: (() => void) | undefined;
    const waitStarted = new Promise<void>((resolve) => {
      resolveWaitStarted = resolve;
    });

    class LockContendedRecoveryManager extends DaemonManager {
      override acquireLock(): boolean {
        lockAttempts++;
        return !lockHeld;
      }

      override releaseLock(): void {}

      override async waitForReady(_timeout: number, signal?: AbortSignal): Promise<boolean> {
        waitSignal = signal;
        resolveWaitStarted?.();
        return await new Promise<boolean>((resolve) => {
          signal?.addEventListener("abort", () => resolve(false), { once: true });
          releaseHolder = () => resolve(false);
        });
      }
    }

    const manager = new LockContendedRecoveryManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      {
        findDaemonProcesses: () => [],
        isProcessRunning: () => false,
      },
      {
        spawn: () => {
          spawnCalls++;
          throw new Error("recovery must not spawn after cancellation");
        },
      },
    );
    const repair = repairDaemon(
      { timeoutMs: 50 },
      {
        timer,
        getHealthReport: async () => ({
          timestamp: "2026-09-14T00:00:00.000Z",
          daemonRunning: false,
          socketExists: false,
          socketAccessible: false,
          pidFileExists: false,
          pidFileValid: false,
          socketConnectable: false,
          recommendations: [],
        }),
        recoverControlState: (options, isProtocolHealthy, signal) =>
          manager.recoverControlState(options, isProtocolHealthy, signal),
      },
    );

    await waitStarted;
    expect(waitSignal).toBeInstanceOf(AbortSignal);
    expect(lockAttempts).toBe(1);

    timer.advanceTime(50);
    const result = await repair;
    expect(result).toMatchObject({ status: "failed", phase: "recovery" });
    expect(waitSignal?.aborted).toBe(true);

    lockHeld = false;
    releaseHolder?.();
    await waitForDaemonRecoveryCompletion(result);

    expect(lockAttempts).toBe(1);
    expect(spawnCalls).toBe(0);
  });

  test("does not spawn after the doctor recovery deadline expires during startup status", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    let spawnCalls = 0;
    let releaseStatus: (() => void) | undefined;
    let resolveStatusStarted: (() => void) | undefined;
    const statusStarted = new Promise<void>((resolve) => {
      resolveStatusStarted = resolve;
    });

    class StatusBlockedRecoveryManager extends DaemonManager {
      override async status(): Promise<{ running: false }> {
        resolveStatusStarted?.();
        return await new Promise<{ running: false }>((resolve) => {
          releaseStatus = () => resolve({ running: false });
        });
      }
    }

    const manager = new StatusBlockedRecoveryManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      {
        findDaemonProcesses: () => [],
        isProcessRunning: () => false,
      },
      {
        spawn: () => {
          spawnCalls++;
          throw new Error("recovery must not spawn after cancellation");
        },
      },
    );
    const repair = repairDaemon(
      { timeoutMs: 50 },
      {
        timer,
        getHealthReport: async () => ({
          timestamp: "2026-09-14T00:00:00.000Z",
          daemonRunning: false,
          socketExists: false,
          socketAccessible: false,
          pidFileExists: false,
          pidFileValid: false,
          socketConnectable: false,
          recommendations: [],
        }),
        recoverControlState: (options, _isProtocolHealthy, signal) =>
          manager.recoverControlState(options, async () => false, signal),
      },
    );

    await statusStarted;
    timer.advanceTime(50);
    const result = await repair;
    expect(result).toMatchObject({ status: "failed", phase: "recovery" });

    releaseStatus?.();
    await waitForDaemonRecoveryCompletion(result);

    expect(spawnCalls).toBe(0);
  });

  test("fails closed rather than signalling an uncorrelated daemon-mode process", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    const livePids = new Set([1234]);
    const processes = new MutableDaemonProcesses(
      [{ pid: 1234, ppid: 1, command: "bun /worktree/dist/src/index.js --daemon-mode" }],
      livePids,
    );
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const signaler: DaemonProcessSignaler = {
      signal: (processId, signal) => {
        signals.push({ pid: processId, signal });
        livePids.delete(processId);
      },
    };
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      processes,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => false },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).rejects.toThrow("could not correlate");
    expect(signals).toEqual([]);
  });

  test("preserves recorded options while stopping the daemon for this namespace", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    const livePids = new Set([1234]);
    const processes = new MutableDaemonProcesses(
      [{ pid: 1234, ppid: 1, command: "bun /worktree/dist/src/index.js --daemon-mode" }],
      livePids,
    );
    writeFileSync(
      pid,
      JSON.stringify({
        pid: 1234,
        socketPath: socket,
        port: 4321,
        startedAt: 1,
        version: "test",
        options: { port: 4321, host: "127.0.0.1", debug: true },
      }),
    );
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const signaler: DaemonProcessSignaler = {
      signal: (processId, signal) => {
        signals.push({ pid: processId, signal });
        livePids.delete(processId);
      },
    };
    const portChecks: Array<{ port: number; host: string }> = [];
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      processes,
      undefined,
      undefined,
      undefined,
      signaler,
      undefined,
      undefined,
      undefined,
      {
        isPortFree: async (port, host) => {
          portChecks.push({ port, host });
          return false;
        },
      },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).rejects.toThrow("port 4321");
    expect(signals).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
    expect(portChecks).toEqual([{ port: 4321, host: "127.0.0.1" }]);
  });

  test("recovers options from dead PID metadata without false CLI defaults erasing one-way flags", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    writeFileSync(
      pid,
      JSON.stringify({
        pid: 1234,
        socketPath: socket,
        port: 4321,
        startedAt: 1,
        version: "test",
        options: {
          port: 4321,
          host: "127.0.0.1",
          debug: true,
          embeddedSdk: true,
          noOcclusion: true,
        },
      }),
    );
    const manager = new DaemonManager(undefined, undefined, timer, lock, pid, socket, {
      findDaemonProcesses: () => [],
      isProcessRunning: () => false,
    });

    const recoveryOptions = await (
      manager as unknown as {
        recoveryOptions(
          status: { running: boolean },
          options: Record<string, unknown>,
        ): Promise<unknown>;
      }
    ).recoveryOptions(
      { running: false },
      {
        debug: false,
        embeddedSdk: false,
        noOcclusion: false,
        host: "0.0.0.0",
      },
    );

    expect(recoveryOptions).toEqual({
      port: 4321,
      host: "0.0.0.0",
      debug: true,
      embeddedSdk: true,
      noOcclusion: true,
      strictPort: true,
    });
  });
});
