import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonManager,
  type DaemonProcessFinder,
  type DaemonProcessLivenessChecker,
  type DaemonProcessRecord,
  type DaemonProcessSignaler,
} from "../../src/daemon/manager";
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

  test("signals only a currently identified daemon-mode process before replacement", async () => {
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

    await expect(manager.recoverControlState()).rejects.toThrow("port 3000");
    expect(signals).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
  });
});
