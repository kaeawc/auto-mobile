import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../../src/daemon/client";
import type { IdentityRecoveryIO } from "../../src/daemon/identityRecovery";
import { DAEMON_SOCKET_PATH_FLAG, parseDaemonSocketPath } from "../../src/daemon/processTable";
import type { DaemonStatus } from "../../src/daemon/types";
import { logger } from "../../src/utils/logger";
import {
  FakeDaemonProcessTable,
  namespaceDaemonProcess,
  unmarkedDaemonProcess,
} from "../fakes/FakeDaemonProcessTable";
import { FakeTimer } from "../fakes/FakeTimer";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";

const windowsSocketPath = String.raw`C:\Users\runneradmin\AppData\Local\Temp\x\daemon.sock`;

/** Only startup readiness/status are scripted; namespace discovery uses the real manager. */
class ReadyWin32Manager extends SafeDaemonManager {
  override async status(): Promise<DaemonStatus> {
    return this.defaultSpawner.calls.length === 0
      ? { running: false }
      : { running: true, pid: 12345, socketPath: spawnedSocketPath(this) };
  }

  override async waitForReady(): Promise<boolean> {
    return true;
  }
}

function spawnedSocketPath(manager: SafeDaemonManager): string {
  const path = parseDaemonSocketPath(manager.defaultSpawner.calls[0].args.join(" "));
  if (path === undefined) {
    throw new Error("Fake launch must contain the manager's resolved namespace marker");
  }
  return path;
}

describe("default Windows namespace owner probe", () => {
  const tempDirs: string[] = [];
  const originalDataDir = process.env.AUTOMOBILE_DATA_DIR;

  function createManager(
    timer: FakeTimer,
    table = new FakeDaemonProcessTable(),
    identityRecoveryIO?: IdentityRecoveryIO,
  ): ReadyWin32Manager {
    const dir = mkdtempSync(join(tmpdir(), "daemon-win32-probe-"));
    tempDirs.push(dir);
    // The launch log is opened under the resolved AutoMobile data dir; keep it
    // off the developer's real ~/.auto-mobile.
    process.env.AUTOMOBILE_DATA_DIR = dir;
    return new ReadyWin32Manager(
      () => {
        throw new Error("Unit tests must not create a real daemon client");
      },
      undefined,
      timer,
      join(dir, "daemon.lock"),
      join(dir, "daemon.pid"),
      windowsSocketPath,
      table,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "win32",
      { isPortFree: async () => true },
      undefined,
      undefined,
      identityRecoveryIO,
    );
  }

  afterEach(() => {
    mock.restore();
    if (originalDataDir === undefined) {
      delete process.env.AUTOMOBILE_DATA_DIR;
    } else {
      process.env.AUTOMOBILE_DATA_DIR = originalDataDir;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("start never consumes fake time or warns for the default win32 probe", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const probe = spyOn(DaemonClient.prototype, "getDaemonStatus").mockImplementation(async () => {
      await timer.sleep(1000);
      throw new Error("Windows namespace probe stalled");
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const manager = createManager(timer);

    await manager.start();

    expect(
      {
        elapsed: timer.now(),
        probeCalls: probe.mock.calls.length,
        warnings: warn.mock.calls.length,
      },
      "default win32 probe must consume zero virtual milliseconds, calls, and warnings",
    ).toEqual({ elapsed: 0, probeCalls: 0, warnings: 0 });
    expect(debug).toHaveBeenCalledWith(
      "No namespace socket owner available for daemon discovery",
      expect.any(Error),
    );
    expect(manager.defaultSpawner.calls).toHaveLength(1);
  });

  test("start resolves without auto-advance instead of hanging in the default win32 probe", async () => {
    const timer = new FakeTimer();
    const probe = spyOn(DaemonClient.prototype, "getDaemonStatus").mockImplementation(async () => {
      await timer.sleep(1000);
      throw new Error("Windows namespace probe stalled");
    });
    spyOn(logger, "warn").mockImplementation(() => {});
    const manager = createManager(timer);
    const start = manager.start();
    let settled = false;
    const completion = start.then(() => {
      settled = true;
    });

    try {
      // One macrotask drains startup's microtasks without advancing any fake deadline.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        settled,
        "start must settle before the macrotask guard without advancing FakeTimer",
      ).toBe(true);
      expect(probe).not.toHaveBeenCalled();
      expect(timer.now()).toBe(0);
      await completion;
    } finally {
      // Release the deliberately stalled mock even during the failing-before demonstration.
      timer.resolveAll();
      await completion;
    }
  });

  test("restart gives namespace orphans the same 12000ms cleanup and handoff window", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const probe = spyOn(DaemonClient.prototype, "getDaemonStatus").mockImplementation(async () => {
      await timer.sleep(1000);
      throw new Error("Windows namespace probe stalled");
    });
    spyOn(logger, "warn").mockImplementation(() => {});
    const table = new FakeDaemonProcessTable();
    const manager = createManager(timer, table);
    await manager.start();
    const socketPath = spawnedSocketPath(manager);
    timer.reset();
    const pids = [452, 453];
    const forcedStopDeadlines = new Map<number, number>();
    // Each orphan remains alive for the 10s graceful budget and 1s after forced stop.
    table.script = () =>
      pids
        .filter((pid) => table.isProcessRunning(pid))
        .map((pid) => ({
          ...namespaceDaemonProcess(pid, socketPath),
          startedAt: pid * 1000,
          processGenerationToken: `generation-${pid}`,
        }));
    spyOn(table, "isProcessRunning").mockImplementation((pid) => {
      if (pid === process.pid) {
        return true;
      }
      if (!pids.includes(pid)) {
        return false;
      }
      if (manager.defaultSignals.some((sent) => sent.pid === pid && sent.signal === "SIGKILL")) {
        if (!forcedStopDeadlines.has(pid)) {
          forcedStopDeadlines.set(pid, timer.now() + 1000);
        }
        return timer.now() < forcedStopDeadlines.get(pid)!;
      }
      return true;
    });
    spyOn(manager, "status").mockResolvedValue({ running: false });
    const start = spyOn(manager, "start").mockResolvedValue(undefined);
    probe.mockClear();

    await manager.restart();

    expect(timer.now(), "default win32 probes must not extend the 12000ms restart window").toBe(
      12000,
    );
    expect(probe).not.toHaveBeenCalled();
    expect(manager.defaultSignals).toEqual([
      { pid: 452, signal: "SIGTERM" },
      { pid: 453, signal: "SIGTERM" },
      { pid: 452, signal: "SIGKILL" },
      { pid: 453, signal: "SIGKILL" },
    ]);
    expect(start).toHaveBeenCalledWith({ strictPort: true });
  });

  test.each([windowsSocketPath, String.raw`\\.\pipe\auto-mobile-ns`, "//./pipe/auto-mobile-ns"])(
    "encoded Windows marker round-trips exactly: %s",
    (socketPath) => {
      expect(
        parseDaemonSocketPath(
          `auto-mobile --daemon-mode ${DAEMON_SOCKET_PATH_FLAG}=${encodeURIComponent(socketPath)}`,
        ),
      ).toBe(socketPath);
    },
  );

  test("win32 namespace markers use the manager's exact resolved path including drive case", async () => {
    const timer = new FakeTimer();
    // Also keep this guard test socket-free in the failing-before state on native Windows.
    spyOn(DaemonClient.prototype, "getDaemonStatus").mockRejectedValue(new Error("ENOENT"));
    const table = new FakeDaemonProcessTable();
    const manager = createManager(timer, table);
    await manager.start();
    const socketPath = spawnedSocketPath(manager);
    const foreignPath = socketPath.replace("C:", "c:");
    expect(foreignPath).not.toBe(socketPath);
    table.script = () => [
      namespaceDaemonProcess(452, socketPath),
      namespaceDaemonProcess(453, foreignPath),
    ];

    expect(manager.findOtherDaemonProcesses(undefined)).toEqual([452]);
    spyOn(manager, "status").mockResolvedValue({ running: false });
    spyOn(manager, "start").mockResolvedValue(undefined);
    table.script = () =>
      [452, 453].map((pid) => ({
        ...namespaceDaemonProcess(pid, pid === 452 ? socketPath : foreignPath),
        startedAt: pid * 1000,
      }));
    spyOn(table, "isProcessRunning").mockImplementation(
      (pid) => pid === process.pid || !manager.defaultSignals.some((sent) => sent.pid === pid),
    );
    timer.enableAutoAdvance();

    await manager.restart();

    expect(manager.defaultSignals).toEqual([{ pid: 452, signal: "SIGTERM" }]);
    expect(table.isProcessRunning(453)).toBe(true);
  });

  test("injected identity IO still probes and attributes an unmarked owner on win32", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const table = new FakeDaemonProcessTable();
    const probe = mock(async (): Promise<DaemonStatus> => ({
      running: true,
      pid: 452,
      processGenerationToken: "owner-452",
    }));
    const manager = createManager(timer, table, {
      socketExists: () => false,
      readRecord: () => null,
      probe,
    });
    table.script = () => [{ ...unmarkedDaemonProcess(452), processGenerationToken: "owner-452" }];
    spyOn(table, "isProcessRunning").mockImplementation(
      (pid) => pid === process.pid || !manager.defaultSignals.some((sent) => sent.pid === pid),
    );
    spyOn(manager, "status").mockResolvedValue({ running: false });
    const start = spyOn(manager, "start").mockResolvedValue(undefined);

    await manager.restart();

    expect(probe).toHaveBeenCalled();
    expect(manager.defaultSignals).toEqual([{ pid: 452, signal: "SIGTERM" }]);
    expect(start).toHaveBeenCalledWith({ strictPort: true });
    expect(timer.now()).toBe(1000);
  });
});
