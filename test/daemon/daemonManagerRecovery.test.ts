import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonManager,
  type DaemonProcessFinder,
  type DaemonProcessLivenessChecker,
  type DaemonProcessSpawner,
  type DaemonProcessRecord,
  type DaemonProcessSignaler,
} from "../../src/daemon/manager";
import { repairDaemon, waitForDaemonRecoveryCompletion } from "../../src/doctor/daemonRecovery";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
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

class SequencedDaemonProcesses implements DaemonProcessFinder, DaemonProcessLivenessChecker {
  private scanIndex = 0;

  constructor(
    private readonly scans: readonly DaemonProcessRecord[][],
    readonly livePids: Set<number>,
    private readonly afterScan?: (scanIndex: number, timeoutMs: number | undefined) => void,
  ) {}

  findDaemonProcesses(timeoutMs?: number): DaemonProcessRecord[] {
    const scanIndex = this.scanIndex++;
    this.afterScan?.(scanIndex, timeoutMs);
    return [...(this.scans[Math.min(scanIndex, this.scans.length - 1)] ?? [])];
  }

  isProcessRunning(pid: number): boolean {
    return this.livePids.has(pid);
  }
}

class CapturingDaemonSpawner implements DaemonProcessSpawner {
  readonly calls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];

  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess {
    this.calls.push({ command, args: [...args], options });
    return new FakeChildProcess() as unknown as ChildProcess;
  }
}

class ImmediatelyReadyRecoveryManager extends DaemonManager {
  override async waitForReady(): Promise<boolean> {
    return true;
  }
}

describe("DaemonManager control-state recovery", () => {
  const tempDirs: string[] = [];
  let originalDataDir: string | undefined;
  let originalLogSink: string | undefined;

  function paths(): { lock: string; pid: string; socket: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-recovery-"));
    tempDirs.push(dir);
    originalDataDir ??= process.env.AUTOMOBILE_DATA_DIR;
    originalLogSink ??= process.env.AUTOMOBILE_LOG_SINK;
    process.env.AUTOMOBILE_DATA_DIR = dir;
    process.env.AUTOMOBILE_LOG_SINK = "stderr";
    return {
      lock: join(dir, "daemon.lock"),
      pid: join(dir, "daemon.pid"),
      socket: join(dir, "daemon.sock"),
    };
  }

  test.each([40, 50])(
    "deducts the survivor scan from the port-probe budget: %s ms",
    async (scanMs) => {
      const { lock, pid, socket } = paths();
      const timer = new FakeTimer();
      const probes: Array<number | undefined> = [];
      const processes = new SequencedDaemonProcesses([[], []], new Set(), (scanIndex) => {
        if (scanIndex === 1) {
          timer.advanceTime(scanMs);
        }
      });
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
        undefined,
        undefined,
        undefined,
        undefined,
        {
          isPortFree: async (_port, _host, timeoutMs) => {
            probes.push(timeoutMs);
            return false;
          },
        },
        undefined,
        async () => false,
      );
      await expect(
        manager.recoverControlState({}, async () => false, undefined, 50),
      ).rejects.toThrow(scanMs === 50 ? "deadline elapsed" : "still in use");
      expect(probes).toEqual(scanMs === 50 ? [] : [10]);
    },
  );

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
    if (originalLogSink === undefined) {
      delete process.env.AUTOMOBILE_LOG_SINK;
    } else {
      process.env.AUTOMOBILE_LOG_SINK = originalLogSink;
    }
    originalLogSink = undefined;
  });

  test("starts a replacement for absent control state without signalling unrelated processes", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const unrelatedLivePids = new Set([9876]);
    const processes = new MutableDaemonProcesses([], unrelatedLivePids);
    const spawner = new CapturingDaemonSpawner();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new ImmediatelyReadyRecoveryManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      processes,
      spawner,
      undefined,
      () => ({ command: "auto-mobile", args: ["--daemon-mode"] }),
      {
        signal: (processId, signal) => signals.push({ pid: processId, signal }),
      },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).resolves.toBe("restarted");

    expect(unrelatedLivePids).toEqual(new Set([9876]));
    expect(signals).toEqual([]);
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]).toMatchObject({
      command: "auto-mobile",
      args: ["--daemon-mode", "--strict-port"],
    });
  });

  test("preserves valid dead PID metadata options when starting a replacement", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
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
    const spawner = new CapturingDaemonSpawner();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new ImmediatelyReadyRecoveryManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      new MutableDaemonProcesses([], new Set()),
      spawner,
      undefined,
      () => ({ command: "auto-mobile", args: ["--daemon-mode"] }),
      {
        signal: (processId, signal) => signals.push({ pid: processId, signal }),
      },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(
      manager.recoverControlState({
        host: "0.0.0.0",
        debug: false,
        embeddedSdk: false,
        noOcclusion: false,
      }),
    ).resolves.toBe("restarted");

    expect(signals).toEqual([]);
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.args).toEqual([
      "--daemon-mode",
      "--port",
      "4321",
      "--host",
      "0.0.0.0",
      "--strict-port",
      "--debug",
      "--embedded-sdk",
      "--no-occlusion",
    ]);
  });

  test("repairs corrupt PID metadata without signalling an uncorrelated process", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeFileSync(pid, "{ definitely not valid JSON");
    const spawner = new CapturingDaemonSpawner();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new ImmediatelyReadyRecoveryManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      new MutableDaemonProcesses([], new Set([9876])),
      spawner,
      undefined,
      () => ({ command: "auto-mobile", args: ["--daemon-mode"] }),
      {
        signal: (processId, signal) => signals.push({ pid: processId, signal }),
      },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).resolves.toBe("restarted");

    expect(signals).toEqual([]);
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.args).toEqual(["--daemon-mode", "--strict-port"]);
  });

  test("stops and replaces the recorded live daemon when its control socket is unresponsive", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const livePids = new Set([1234]);
    const processes = new MutableDaemonProcesses(
      [{ pid: 1234, ppid: 1, command: "auto-mobile --daemon-mode", startedAt: 1 }],
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
    const spawner = new CapturingDaemonSpawner();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new ImmediatelyReadyRecoveryManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      processes,
      spawner,
      undefined,
      () => ({ command: "auto-mobile", args: ["--daemon-mode"] }),
      {
        signal: (processId, signal) => {
          signals.push({ pid: processId, signal });
          livePids.delete(processId);
        },
      },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).resolves.toBe("restarted");

    expect(signals).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.args).toEqual([
      "--daemon-mode",
      "--port",
      "4321",
      "--host",
      "127.0.0.1",
      "--strict-port",
      "--debug",
    ]);
  });

  test("refuses multiple uncorrelated live daemon candidates without signalling either", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    const livePids = new Set([1234, 5678]);
    const processes = new MutableDaemonProcesses(
      [
        { pid: 1234, ppid: 1, command: "auto-mobile --daemon-mode" },
        { pid: 5678, ppid: 1, command: "auto-mobile --daemon-mode" },
      ],
      livePids,
    );
    const spawner = new CapturingDaemonSpawner();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new ImmediatelyReadyRecoveryManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      processes,
      spawner,
      undefined,
      () => ({ command: "auto-mobile", args: ["--daemon-mode"] }),
      {
        signal: (processId, signal) => signals.push({ pid: processId, signal }),
      },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).rejects.toThrow("could not correlate");

    expect(signals).toEqual([]);
    expect(spawner.calls).toEqual([]);
  });

  test("joins a healthy successor found after acquiring the lifecycle lock", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    const livePids = new Set([1234]);
    const processes = new MutableDaemonProcesses(
      [
        {
          pid: 1234,
          ppid: 1,
          command: "bun /worktree/dist/src/index.js --daemon-mode",
          startedAt: 1,
        },
      ],
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
      [
        {
          pid: 1234,
          ppid: 1,
          command: "bun /worktree/dist/src/index.js --daemon-mode",
          startedAt: 1,
        },
      ],
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

  test("refuses a reused PID whose process generation differs from the PID record", async () => {
    const { lock, pid, socket } = paths();
    writeFileSync(
      pid,
      JSON.stringify({
        pid: 1234,
        socketPath: socket,
        port: 4321,
        startedAt: 1,
        version: "test",
      }),
    );
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new DaemonManager(
      undefined,
      undefined,
      new FakeTimer(),
      lock,
      pid,
      socket,
      new MutableDaemonProcesses(
        [{ pid: 1234, ppid: 1, command: "auto-mobile --daemon-mode", startedAt: 10_000 }],
        new Set([1234]),
      ),
      undefined,
      undefined,
      undefined,
      { signal: (processId, signal) => signals.push({ pid: processId, signal }) },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).rejects.toThrow("could not correlate");
    expect(signals).toEqual([]);
  });

  test("does not use a legacy daemon-bootstrap timestamp to accept an arbitrarily older process", async () => {
    const { lock, pid, socket } = paths();
    writeFileSync(
      pid,
      JSON.stringify({
        pid: 1234,
        socketPath: socket,
        port: 4321,
        // Old PID records have no processStartedAt. Their daemon-bootstrap
        // timestamp cannot prove that a much older process is this generation.
        startedAt: 6_000,
        version: "test",
      }),
    );
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new DaemonManager(
      undefined,
      undefined,
      new FakeTimer(),
      lock,
      pid,
      socket,
      new MutableDaemonProcesses(
        [{ pid: 1234, ppid: 1, command: "auto-mobile --daemon-mode", startedAt: 1_000 }],
        new Set([1234]),
      ),
      undefined,
      undefined,
      undefined,
      { signal: (processId, signal) => signals.push({ pid: processId, signal }) },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).rejects.toThrow("could not correlate");
    expect(signals).toEqual([]);
  });

  test("accepts a recorded daemon whose bootstrap began after OS process birth", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const livePids = new Set([1234]);
    const processes = new MutableDaemonProcesses(
      [{ pid: 1234, ppid: 1, command: "auto-mobile --daemon-mode", startedAt: 1_000 }],
      livePids,
    );
    writeFileSync(
      pid,
      JSON.stringify({
        pid: 1234,
        socketPath: socket,
        port: 4321,
        // Daemon metadata is created after a deliberately slow bootstrap.
        startedAt: 6_000,
        // New PID metadata records the OS process birth independently from the
        // delayed daemon bootstrap timestamp.
        processStartedAt: 1_000,
        version: "test",
      }),
    );
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const spawner = new CapturingDaemonSpawner();
    const manager = new ImmediatelyReadyRecoveryManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      processes,
      spawner,
      undefined,
      () => ({ command: "auto-mobile", args: ["--daemon-mode"] }),
      {
        signal: (processId, signal) => {
          signals.push({ pid: processId, signal });
          livePids.delete(processId);
        },
      },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).resolves.toBe("restarted");

    expect(signals).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
    expect(spawner.calls).toHaveLength(1);
  });

  test("uses a Linux generation token after an NTP wall-clock correction", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processGenerationToken = "linux:boot-id:424242";
    const livePids = new Set([1234]);
    const processes = new MutableDaemonProcesses(
      [
        {
          pid: 1234,
          ppid: 1,
          command: "auto-mobile --daemon-mode",
          // This intentionally disagrees with the old wall-clock estimate.
          startedAt: 3_601_000,
          processGenerationToken,
        },
      ],
      livePids,
    );
    writeFileSync(
      pid,
      JSON.stringify({
        pid: 1234,
        socketPath: socket,
        port: 4321,
        startedAt: 6_000,
        processStartedAt: 1_000,
        processGenerationToken,
        version: "test",
      }),
    );
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new ImmediatelyReadyRecoveryManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      processes,
      new CapturingDaemonSpawner(),
      undefined,
      () => ({ command: "auto-mobile", args: ["--daemon-mode"] }),
      {
        signal: (processId, signal) => {
          signals.push({ pid: processId, signal });
          livePids.delete(processId);
        },
      },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).resolves.toBe("restarted");
    expect(signals).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
  });

  test("uses the Darwin generation token through an ambiguous DST fall-back hour", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const processGenerationToken = "darwin:Sun Nov 1 01:30:00 2026";
    const livePids = new Set([1234]);
    const processes = new MutableDaemonProcesses(
      [
        {
          pid: 1234,
          ppid: 1,
          command: "auto-mobile --daemon-mode",
          // The two local 01:30 occurrences are an hour apart in epoch time.
          startedAt: 1_793_513_400_000,
          processGenerationToken,
        },
      ],
      livePids,
    );
    writeFileSync(
      pid,
      JSON.stringify({
        pid: 1234,
        socketPath: socket,
        port: 4321,
        startedAt: 6_000,
        processStartedAt: 1_793_509_800_000,
        processGenerationToken,
        version: "test",
      }),
    );
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = new ImmediatelyReadyRecoveryManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      processes,
      new CapturingDaemonSpawner(),
      undefined,
      () => ({ command: "auto-mobile", args: ["--daemon-mode"] }),
      {
        signal: (processId, signal) => {
          signals.push({ pid: processId, signal });
          livePids.delete(processId);
        },
      },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).resolves.toBe("restarted");
    expect(signals).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
  });

  test("does not SIGTERM a PID reused after recovery initially verified its generation", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    const expected = {
      pid: 1234,
      ppid: 1,
      command: "auto-mobile --daemon-mode",
      startedAt: 1_000,
      processGenerationToken: "linux:boot-id:1",
    };
    const replacement = {
      ...expected,
      startedAt: 10_000,
      processGenerationToken: "linux:boot-id:2",
    };
    const processes = new SequencedDaemonProcesses(
      [[expected], [replacement]],
      new Set([expected.pid]),
    );
    writeFileSync(
      pid,
      JSON.stringify({
        pid: expected.pid,
        socketPath: socket,
        port: 4321,
        startedAt: 6_000,
        processStartedAt: expected.startedAt,
        processGenerationToken: expected.processGenerationToken,
        version: "test",
      }),
    );
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
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
      { signal: (processId, signal) => signals.push({ pid: processId, signal }) },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).rejects.toThrow("PID was reused");
    expect(signals).toEqual([]);
  });

  test("does not SIGKILL a PID reused after SIGTERM", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const expected = {
      pid: 1234,
      ppid: 1,
      command: "auto-mobile --daemon-mode",
      startedAt: 1_000,
      processGenerationToken: "linux:boot-id:1",
    };
    const replacement = {
      ...expected,
      startedAt: 10_000,
      processGenerationToken: "linux:boot-id:2",
    };
    const processes = new SequencedDaemonProcesses(
      [[expected], [expected], [replacement]],
      new Set([expected.pid]),
    );
    writeFileSync(
      pid,
      JSON.stringify({
        pid: expected.pid,
        socketPath: socket,
        port: 4321,
        startedAt: 6_000,
        processStartedAt: expected.startedAt,
        processGenerationToken: expected.processGenerationToken,
        version: "test",
      }),
    );
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
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
      { signal: (processId, signal) => signals.push({ pid: processId, signal }) },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState()).rejects.toThrow("PID was reused");
    expect(signals).toEqual([{ pid: expected.pid, signal: "SIGTERM" }]);
  });

  test("fails closed when the nested pre-signal scan exhausts the recovery deadline", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    const expected = {
      pid: 1234,
      ppid: 1,
      command: "auto-mobile --daemon-mode",
      startedAt: 1_000,
    };
    const scanTimeouts: Array<number | undefined> = [];
    const processes = new SequencedDaemonProcesses(
      [[expected], [expected]],
      new Set([expected.pid]),
      (scanIndex, timeoutMs) => {
        scanTimeouts.push(timeoutMs);
        if (scanIndex === 1) {
          timer.advanceTime(50);
        }
      },
    );
    writeFileSync(
      pid,
      JSON.stringify({
        pid: expected.pid,
        socketPath: socket,
        port: 4321,
        startedAt: 6_000,
        processStartedAt: expected.startedAt,
        version: "test",
      }),
    );
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
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
      { signal: (processId, signal) => signals.push({ pid: processId, signal }) },
      undefined,
      undefined,
      undefined,
      { isPortFree: async () => true },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState({}, async () => false, undefined, 50)).rejects.toThrow(
      "deadline elapsed before process-table inspection",
    );
    expect(scanTimeouts).toEqual([50, 50]);
    expect(signals).toEqual([]);
  });

  test("keeps lock-takeover recovery behind its canonical-port guard", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    let lockAttempts = 0;
    let readinessWaits = 0;
    const portChecks: Array<{ port: number; host: string }> = [];
    const spawner = new CapturingDaemonSpawner();

    class LockTakeoverRecoveryManager extends DaemonManager {
      override acquireLock(): boolean {
        lockAttempts++;
        return lockAttempts >= 2;
      }

      override releaseLock(): void {}

      override async waitForReady(): Promise<boolean> {
        readinessWaits++;
        return readinessWaits > 1;
      }
    }

    const manager = new LockTakeoverRecoveryManager(
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
      spawner,
      undefined,
      () => ({ command: "auto-mobile", args: ["--daemon-mode"] }),
      undefined,
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

    await expect(manager.recoverControlState({ port: 4321 })).rejects.toThrow("port 4321");

    expect(lockAttempts).toBe(2);
    expect(portChecks).toEqual([{ port: 4321, host: "127.0.0.1" }]);
    expect(spawner.calls).toEqual([]);
  });

  test("passes the remaining recovery budget to both scans and the port probe", async () => {
    const { lock, pid, socket } = paths();
    const timer = new FakeTimer();
    const scanTimeouts: Array<number | undefined> = [];
    const portProbeTimeouts: Array<number | undefined> = [];
    let scans = 0;
    const manager = new DaemonManager(
      undefined,
      undefined,
      timer,
      lock,
      pid,
      socket,
      {
        findDaemonProcesses: (timeoutMs) => {
          scanTimeouts.push(timeoutMs);
          scans++;
          if (scans === 2) {
            timer.advanceTime(10);
          }
          return [];
        },
        isProcessRunning: () => false,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        isPortFree: async (_port, _host, timeoutMs) => {
          portProbeTimeouts.push(timeoutMs);
          return false;
        },
      },
      undefined,
      async () => false,
    );

    await expect(manager.recoverControlState({}, async () => false, undefined, 25)).rejects.toThrow(
      "port 3000",
    );
    expect(scanTimeouts).toEqual([25, 25]);
    expect(portProbeTimeouts).toEqual([15]);
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

  test("uses last-requested-wins exact tool selections during doctor recovery", async () => {
    const { lock, pid, socket } = paths();
    const manager = new DaemonManager(undefined, undefined, new FakeTimer(), lock, pid, socket, {
      findDaemonProcesses: () => [],
      isProcessRunning: () => false,
    });

    const recoveryOptions = await (
      manager as unknown as {
        recoveryOptions(
          status: { running: boolean; options: Record<string, unknown> },
          options: Record<string, unknown>,
        ): Promise<unknown>;
      }
    ).recoveryOptions(
      {
        running: false,
        options: {
          enabledTools: ["observe", "clipboard"],
          disabledTools: ["tapOn"],
        },
      },
      {
        enabledTools: ["tapOn"],
        disabledTools: ["observe"],
      },
    );

    expect(recoveryOptions).toEqual({
      enabledTools: ["clipboard", "tapOn"],
      disabledTools: ["observe"],
      strictPort: true,
    });
  });
});
