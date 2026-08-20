import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonManager, type DaemonProcessSpawner } from "../../src/daemon/manager";
import { READINESS_PROBE_MAX_ATTEMPTS } from "../../src/daemon/constants";
import type { DaemonClientLike } from "../../src/daemon/client";
import type { PidFileData } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import type { ChildProcess, SpawnOptions } from "node:child_process";

class ProbeClient implements DaemonClientLike {
  connectCallCount = 0;
  closeCallCount = 0;

  constructor(private readonly canConnect: boolean) {}

  async connect(): Promise<void> {
    this.connectCallCount++;
    if (!this.canConnect) {
      throw new Error("socket not accepting connections");
    }
  }

  async close(): Promise<void> {
    this.closeCallCount++;
  }

  async callTool(): Promise<any> {
    throw new Error("not used");
  }

  async readResource(): Promise<any> {
    throw new Error("not used");
  }

  async callDaemonMethod(): Promise<any> {
    throw new Error("not used");
  }
}

class FakeDaemonProcess extends EventEmitter {
  pid = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly signals: NodeJS.Signals[] = [];

  unref(): void {}

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.signals.push(signal);
    this.exitCode = 0;
    this.signalCode = signal;
    this.emit("exit", 0, signal);
    return true;
  }
}

class FakeDaemonSpawner implements DaemonProcessSpawner {
  readonly spawned: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  readonly process = new FakeDaemonProcess();
  logText = "";
  onSpawn?: (process: FakeDaemonProcess) => void;

  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess {
    this.spawned.push({ command, args, options });
    const logFd = Array.isArray(options.stdio) && typeof options.stdio[1] === "number"
      ? options.stdio[1]
      : undefined;
    if (logFd !== undefined && this.logText.length > 0) {
      writeSync(logFd, this.logText);
    }
    if (this.onSpawn) {
      setImmediate(() => this.onSpawn!(this.process));
    }
    return this.process as unknown as ChildProcess;
  }
}

describe("DaemonManager readiness", () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];

  function createPaths(): { dir: string; lockPath: string; pidPath: string; socketPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-readiness-test-"));
    tempDirs.push(dir);
    // Keep the daemon launch log inside this test's temp dir instead of the real
    // `~/.auto-mobile/logs` default (see tempDir.resolveAutoMobileBaseDir).
    process.env.AUTOMOBILE_DATA_DIR = dir;
    return {
      dir,
      lockPath: join(dir, "daemon.lock"),
      pidPath: join(dir, "daemon.pid"),
      socketPath: join(dir, "daemon.sock"),
    };
  }

  function writePidFile(pidPath: string, socketPath: string): void {
    const pidData: PidFileData = {
      pid: process.pid,
      socketPath,
      port: 31879,
      startedAt: 0,
      version: "test",
    };
    writeFileSync(pidPath, JSON.stringify(pidData), { mode: 0o600 });
  }

  afterEach(async () => {
    await Promise.all(
      servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))
    );
    servers.length = 0;

    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
    delete process.env.AUTOMOBILE_DATA_DIR;
  });

  test("reports ready only after the daemon socket accepts a connection", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const clients: ProbeClient[] = [];
    writePidFile(pidPath, socketPath);
    writeFileSync(socketPath, "socket placeholder");

    const manager = new DaemonManager(
      () => {
        const client = new ProbeClient(true);
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath
    );

    await expect(manager.waitForReady(100)).resolves.toBe(true);
    expect(clients).toHaveLength(1);
    expect(clients[0].connectCallCount).toBe(1);
    expect(clients[0].closeCallCount).toBe(1);
    expect(existsSync(socketPath)).toBe(true);
  });

  test("reports direct socket readiness when this namespace has no PID record", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const clients: ProbeClient[] = [];
    // A daemon from another checkout can own this namespace's socket without
    // writing its PID metadata here. The successful direct connection is enough
    // to reuse it; no PID file is written for this namespace.
    writeFileSync(socketPath, "socket placeholder");

    const manager = new DaemonManager(
      () => {
        const client = new ProbeClient(true);
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath
    );

    await expect(manager.waitForReady(100)).resolves.toBe(true);
    expect(clients).toHaveLength(1);
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(socketPath)).toBe(true);
  });

  test("removes an invalid non-socket path and keeps waiting when the PID is alive", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const clients: ProbeClient[] = [];
    writePidFile(pidPath, socketPath);
    writeFileSync(socketPath, "stale socket placeholder");

    const manager = new DaemonManager(
      () => {
        const client = new ProbeClient(false);
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath
    );

    await expect(manager.waitForReady(250)).resolves.toBe(false);
    // The probe is retried before the socket is treated as dead, so a fully
    // unreachable socket is probed READINESS_PROBE_MAX_ATTEMPTS times.
    expect(clients).toHaveLength(READINESS_PROBE_MAX_ATTEMPTS);
    expect(clients[0].connectCallCount).toBe(1);
    expect(clients[0].closeCallCount).toBe(1);
    expect(existsSync(socketPath)).toBe(false);
  });

  // A daemon killed with SIGKILL leaves its Unix socket pathname behind as a
  // socket inode. If the PID is later reused, status() reports running, but the
  // readiness probe still cannot connect. The stale socket inode must be removed
  // so the loop does not spin until timeout (and so a fresh daemon can bind it).
  // Gated off Windows: net.Server.listen(path) there means a named pipe, not a
  // filesystem socket inode, so a real socket inode cannot be created this way.
  test.skipIf(process.platform === "win32")(
    "removes a stale socket inode when the readiness probe cannot connect",
    async () => {
      const { lockPath, pidPath, socketPath } = createPaths();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const clients: ProbeClient[] = [];
      writePidFile(pidPath, socketPath);

      // Bind a real Unix socket so the path is a genuine socket inode (the case
      // the previous isSocket() guard wrongly preserved). The probe still fails
      // because it cannot complete the daemon handshake, so the inode is stale
      // from the client's perspective and must be removed. Left listening for
      // afterEach cleanup; closing here would unlink the inode itself.
      const server = createServer();
      servers.push(server);
      await new Promise<void>(resolve => server.listen(socketPath, resolve));
      expect(existsSync(socketPath)).toBe(true);

      const manager = new DaemonManager(
        () => {
          const client = new ProbeClient(false);
          clients.push(client);
          return client;
        },
        undefined,
        fakeTimer,
        lockPath,
        pidPath,
        socketPath
      );

      await expect(manager.waitForReady(250)).resolves.toBe(false);
      expect(clients).toHaveLength(READINESS_PROBE_MAX_ATTEMPTS);
      expect(clients[0].connectCallCount).toBe(1);
      expect(clients[0].closeCallCount).toBe(1);
      expect(existsSync(socketPath)).toBe(false);
    }
  );

  // Regression guard for "devices not found after daemon start/restart": a LIVE
  // daemon can transiently refuse the readiness probe (backlog overflow, slow
  // first accept after a restart). The probe must retry and recover instead of
  // unlinking the healthy daemon's socket — otherwise every later client connect
  // throws "Daemon socket not found" and all device calls fail.
  test("recovers on a later retry without removing a live daemon's socket", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const clients: ProbeClient[] = [];
    writePidFile(pidPath, socketPath);
    writeFileSync(socketPath, "socket placeholder");

    // Fail the first attempts, then accept — simulating a transient blip.
    let attempt = 0;
    const manager = new DaemonManager(
      () => {
        attempt++;
        const client = new ProbeClient(attempt >= READINESS_PROBE_MAX_ATTEMPTS);
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath
    );

    await expect(manager.waitForReady(1000)).resolves.toBe(true);
    expect(clients).toHaveLength(READINESS_PROBE_MAX_ATTEMPTS);
    // The socket of a daemon that recovered must be preserved.
    expect(existsSync(socketPath)).toBe(true);
  });

  test("waitForReady cancels pending polling sleep when aborted", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    const controller = new AbortController();
    const clients: ProbeClient[] = [];

    const manager = new DaemonManager(
      () => {
        const client = new ProbeClient(false);
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath
    );

    const ready = manager.waitForReady(10_000, controller.signal);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);

    controller.abort();

    await expect(ready).resolves.toBe(false);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    expect(clients).toHaveLength(0);
  });

  test("reports elapsed readiness timing when no daemon socket appears", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath
    );

    try {
      await expect(manager.waitForReady(200)).resolves.toBe(false);
      expect(stderr).toHaveBeenCalledWith(
        "Daemon readiness probe timed out after 200ms (2 polls; socket not observed)\n"
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("startup timeout includes bounded daemon log context", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const spawner = new FakeDaemonSpawner();
    spawner.logText = `OLD_LOG_START\n${"a".repeat(5000)}\nSQLiteError: database is locked\nstack line\n`;

    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner
    );
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(async () => false);

    try {
      await manager.start();
      expect.unreachable("start should fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(
        /Daemon failed to start within \d+ms[\s\S]*Logs: .*daemon-launch-\d+\.log[\s\S]*SQLiteError: database is locked/
      );
      expect(message).not.toContain("OLD_LOG_START");
      expect(spawner.process.signals).toEqual(["SIGTERM"]);
    } finally {
      readySpy.mockRestore();
      findSpy.mockRestore();
    }
  });

  test("preserves the spawned daemon when its exact PID becomes reachable at the deadline", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    const spawner = new FakeDaemonSpawner();
    const clients: ProbeClient[] = [];
    const manager = new DaemonManager(
      () => {
        const client = new ProbeClient(true);
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner
    );
    let statusCalls = 0;
    const statusSpy = spyOn(manager, "status").mockImplementation(async () => {
      statusCalls++;
      if (statusCalls === 1) {
        return { running: false };
      }
      return {
        running: true,
        pid: spawner.process.pid,
        port: 31879,
        socketPath,
      };
    });
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);
    const readySpy = spyOn(manager, "waitForReady").mockResolvedValue(false);

    try {
      await expect(manager.start()).resolves.toBeUndefined();
      expect(statusCalls).toBe(3);
      expect(clients[0].connectCallCount).toBe(1);
      expect(spawner.process.signals).toEqual([]);
    } finally {
      statusSpy.mockRestore();
      findSpy.mockRestore();
      readySpy.mockRestore();
    }
  });

  test("early daemon subprocess exit includes exit code and log context", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const spawner = new FakeDaemonSpawner();
    spawner.logText = "fatal startup error\nSQLITE_BUSY: database is locked\n";
    spawner.onSpawn = process => process.emit("exit", 7, null);

    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner
    );
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {})
    );

    try {
      await expect(manager.start()).rejects.toThrow(
        /Daemon subprocess exited before becoming ready \(exit code 7\)[\s\S]*SQLITE_BUSY: database is locked/
      );
    } finally {
      readySpy.mockRestore();
      findSpy.mockRestore();
    }
  });

  test("subprocess failure wins when readiness polling is aborted", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    const spawner = new FakeDaemonSpawner();
    spawner.logText = "fatal startup error\nSQLITE_BUSY: database is locked\n";
    spawner.onSpawn = process => process.emit("exit", 7, null);

    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner
    );
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);

    try {
      await expect(manager.start()).rejects.toThrow(
        /Daemon subprocess exited before becoming ready \(exit code 7\)[\s\S]*SQLITE_BUSY: database is locked/
      );
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      findSpy.mockRestore();
    }
  });

  test("spawn failures preserve the raw spawn error", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const spawner = new FakeDaemonSpawner();
    spawner.onSpawn = process => {
      const error = new Error("spawn /bin/sh ENOENT");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      process.emit("error", error);
    };

    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner
    );
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {})
    );

    try {
      await expect(manager.start()).rejects.toThrow(
        /Daemon subprocess failed to spawn: spawn \/bin\/sh ENOENT/
      );
    } finally {
      readySpy.mockRestore();
      findSpy.mockRestore();
    }
  });
});
