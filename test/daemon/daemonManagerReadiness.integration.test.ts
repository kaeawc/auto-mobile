import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonManager, type DaemonProcessSpawner } from "../../src/daemon/manager";
import {
  DAEMON_STARTUP_TIMEOUT_MS,
  READINESS_PROBE_MAX_ATTEMPTS,
} from "../../src/daemon/constants";
import type { DaemonClientLike } from "../../src/daemon/client";
import type { PidFileData } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import type { ChildProcess, SpawnOptions } from "node:child_process";

class ProbeClient implements DaemonClientLike {
  connectCallCount = 0;
  closeCallCount = 0;
  readonly connectionTimeouts: number[] = [];
  readonly connectionSignals: AbortSignal[] = [];

  constructor(private readonly canConnect: boolean) {}

  async connect(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    this.connectCallCount++;
    if (timeoutMs !== undefined) {
      this.connectionTimeouts.push(timeoutMs);
    }
    if (signal !== undefined) {
      this.connectionSignals.push(signal);
    }
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
    const logFd =
      Array.isArray(options.stdio) && typeof options.stdio[1] === "number"
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
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
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
      socketPath,
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
      socketPath,
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
      socketPath,
    );

    await expect(manager.waitForReady(250)).resolves.toBe(false);
    // The probe is retried before the socket is treated as dead, bounded by the
    // remaining readiness deadline. A slow probe can consume the remaining budget
    // before every retry runs.
    expect(clients.length).toBeGreaterThan(0);
    expect(clients.length).toBeLessThanOrEqual(READINESS_PROBE_MAX_ATTEMPTS);
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
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
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
        socketPath,
      );

      await expect(manager.waitForReady(250)).resolves.toBe(false);
      expect(clients.length).toBeGreaterThan(0);
      expect(clients.length).toBeLessThanOrEqual(READINESS_PROBE_MAX_ATTEMPTS);
      expect(clients[0].connectCallCount).toBe(1);
      expect(clients[0].closeCallCount).toBe(1);
      expect(existsSync(socketPath)).toBe(false);
    },
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
      socketPath,
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
      socketPath,
    );

    const ready = manager.waitForReady(10_000, controller.signal);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);

    controller.abort();

    await expect(ready).resolves.toBe(false);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    expect(clients).toHaveLength(0);
  });

  test("bounds a stalled socket connection by the remaining readiness deadline", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    const clients: ProbeClient[] = [];
    writeFileSync(socketPath, "socket placeholder");

    const manager = new DaemonManager(
      () => {
        const client = new ProbeClient(true);
        client.connect = async (timeoutMs?: number, signal?: AbortSignal) => {
          client.connectCallCount++;
          if (timeoutMs !== undefined) {
            client.connectionTimeouts.push(timeoutMs);
          }
          if (signal !== undefined) {
            client.connectionSignals.push(signal);
          }
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("probe aborted")), {
              once: true,
            });
          });
        };
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
    );

    const ready = manager.waitForReady(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(clients).toHaveLength(1);
    expect(clients[0].connectionTimeouts).toEqual([100]);

    fakeTimer.advanceTime(100);

    await expect(ready).resolves.toBe(false);
    expect(clients[0].connectionSignals[0].aborted).toBe(true);
  });

  test("aborts a stalled full-budget probe the instant the lock holder dies mid-probe (#5904)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    writePidFile(pidPath, socketPath);
    writeFileSync(socketPath, "socket placeholder");

    const clients: ProbeClient[] = [];
    const manager = new DaemonManager(
      () => {
        const client = new ProbeClient(true);
        // Model an accepts-but-never-responds socket: connect() stalls forever and
        // only settles when the probe's abort signal fires.
        client.connect = async (timeoutMs?: number, signal?: AbortSignal) => {
          client.connectCallCount++;
          if (timeoutMs !== undefined) {
            client.connectionTimeouts.push(timeoutMs);
          }
          if (signal !== undefined) {
            client.connectionSignals.push(signal);
          }
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("probe aborted"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new Error("probe aborted")), {
              once: true,
            });
          });
        };
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
    );

    // The holder is alive at the poll boundary (so the full budget is taken) but
    // dies during the stalled probe; the liveness watchdog must interrupt the probe
    // rather than let it absorb the whole DAEMON_STARTUP_TIMEOUT_MS budget (#5904).
    let holderAlive = true;
    let samples = 0;
    const shouldContinueWaiting = () => {
      samples++;
      // Alive for the first sample (the poll-boundary precheck), dead thereafter.
      if (samples > 1) {
        holderAlive = false;
      }
      return holderAlive;
    };

    await expect(manager.waitForReady(30_000, undefined, shouldContinueWaiting)).resolves.toBe(
      false,
    );
    // Interrupted early: fake time is nowhere near the 30s budget the un-watched
    // probe would have consumed.
    expect(fakeTimer.getCurrentTime()).toBeLessThan(1_000);
    expect(clients).toHaveLength(1);
    expect(clients[0].connectionSignals[0]?.aborted).toBe(true);
  });

  test("waitForLockHolderReadiness re-arbitrates across a token-distinguished replacement holder (#5904)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Initial holder: this process's PID with token A.
    writeFileSync(lockPath, `${process.pid}\ntoken-a`);
    let waits = 0;

    class TestDaemonManager extends DaemonManager {
      override async waitForReady(): Promise<boolean> {
        waits++;
        if (waits === 1) {
          // A replacement reclaims the lock with the same PID but a different token
          // between this wait ending and the re-arbitration read (A crashed, B took
          // over). Path 1 must wait on B rather than throwing on A being gone.
          writeFileSync(lockPath, `${process.pid}\ntoken-b`);
        }
        return false;
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
    );

    await expect(manager.waitForLockHolderReadiness(30_000)).resolves.toBe(false);
    // Wait on holder A, then re-arbitrate onto the token-B replacement (#2); B stays
    // put so the wait then ends. Two waits, not the single wait a lone liveness-gated
    // waitForReady would allow before throwing.
    expect(waits).toBe(2);
  });

  test("re-arbitrates when a legacy holder gains an owner token (#5928)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    writeFileSync(lockPath, String(process.pid));
    let waits = 0;

    class TestDaemonManager extends DaemonManager {
      override async waitForReady(): Promise<boolean> {
        waits++;
        if (waits === 1) {
          writeFileSync(lockPath, `${process.pid}\ntoken-b`);
        }
        return false;
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
    );

    await expect(manager.waitForLockHolderReadiness(30_000)).resolves.toBe(false);
    expect(waits).toBe(2);
  });

  test("waitForLockHolderReadiness confirms a daemon that published its socket before releasing the lock (#5904)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    writePidFile(pidPath, socketPath);
    writeFileSync(socketPath, "socket placeholder");
    // Initial holder present and alive.
    writeFileSync(lockPath, `${process.pid}\ntoken-a`);

    const clients: ProbeClient[] = [];

    class TestDaemonManager extends DaemonManager {
      override async waitForReady(): Promise<boolean> {
        // The holder published the socket, then released its lock during our probe
        // (the watchdog aborts a slow-but-healthy in-flight connect the instant the
        // lock is gone). Model that: the lock file vanishes, but the socket stays
        // connectable. The loop then sees the holder gone; only the final confirm
        // catches that the daemon is actually up.
        rmSync(lockPath, { force: true });
        return false;
      }
    }

    const manager = new TestDaemonManager(
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
    );

    // Without the final non-destructive confirm, the holder-gone exit would report
    // false and the proxy would throw DaemonUnavailableError for a reachable daemon.
    await expect(manager.waitForLockHolderReadiness(30_000)).resolves.toBe(true);
    expect(clients.length).toBeGreaterThan(0);
  });

  test("waitForLockHolderReadiness stops on the same live holder without re-arbitrating (#5904)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    writeFileSync(lockPath, `${process.pid}\ntoken-a`);
    let waits = 0;

    class TestDaemonManager extends DaemonManager {
      override async waitForReady(): Promise<boolean> {
        waits++;
        // Holder never changes: same PID, same token — a genuinely stuck holder.
        return false;
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
    );

    await expect(manager.waitForLockHolderReadiness(30_000)).resolves.toBe(false);
    // No replacement, so exactly one wait: the loop must not spin on an unchanging
    // live holder.
    expect(waits).toBe(1);
  });

  test("aborts a stalled probe when the lock holder identity changes (#5928)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    writeFileSync(lockPath, `${process.pid}\ntoken-a`);
    writeFileSync(socketPath, "socket placeholder");

    const clients: ProbeClient[] = [];
    const manager = new DaemonManager(
      () => {
        const client = new ProbeClient(false);
        client.connect = async (_timeoutMs?: number, signal?: AbortSignal) => {
          client.connectCallCount++;
          if (signal !== undefined) {
            client.connectionSignals.push(signal);
          }
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error("probe aborted"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new Error("probe aborted")), {
              once: true,
            });
          });
        };
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
    );

    // Change the holder after the initial poll-boundary check, while the socket
    // probe is stalled. The identity-aware watchdog must interrupt that probe.
    fakeTimer.setTimeout(() => {
      writeFileSync(lockPath, `${process.pid}\ntoken-b`);
    }, 100);

    await expect(manager.waitForLockHolderReadiness(250)).resolves.toBe(false);
    expect(clients.length).toBeGreaterThanOrEqual(2);
    expect(clients[0]?.connectionSignals[0]?.aborted).toBe(true);
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
      socketPath,
    );

    try {
      await expect(manager.waitForReady(200)).resolves.toBe(false);
      expect(stderr).toHaveBeenCalledWith(
        "Daemon readiness probe timed out after 200ms (2 polls; socket not observed)\n",
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
      spawner,
    );
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(async () => false);

    try {
      await manager.start();
      expect.unreachable("start should fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(
        /Daemon failed to start within \d+ms[\s\S]*Logs: .*daemon-launch-\d+\.log[\s\S]*SQLiteError: database is locked/,
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
      spawner,
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
    spawner.onSpawn = (process) => process.emit("exit", 7, null);

    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
    );
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {}),
    );

    try {
      await expect(manager.start()).rejects.toThrow(
        /Daemon subprocess exited before becoming ready \(exit code 7\)[\s\S]*SQLITE_BUSY: database is locked/,
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
    spawner.onSpawn = (process) => process.emit("exit", 7, null);

    const manager = new DaemonManager(
      undefined,
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
    );
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);

    try {
      await expect(manager.start()).rejects.toThrow(
        /Daemon subprocess exited before becoming ready \(exit code 7\)[\s\S]*SQLITE_BUSY: database is locked/,
      );
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      findSpy.mockRestore();
    }
  });

  test("joins a peer daemon that publishes the socket just after our subprocess exits (#6103)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const spawner = new FakeDaemonSpawner();
    // Our spawned child loses the socket-ownership race and exits 1 with an empty
    // launch log, exactly as observed in #6103.
    spawner.onSpawn = (process) => process.emit("exit", 1, null);

    // A peer client's same-version daemon is coming up: it publishes the shared
    // socket a beat after our child died, so the readiness probe only succeeds once
    // the peer is ready.
    let peerSocketReady = false;
    const clients: ProbeClient[] = [];
    const manager = new DaemonManager(
      () => {
        const client = new ProbeClient(peerSocketReady);
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
    );

    // No live daemon before we spawn (so start() spawns our own child), but a peer
    // daemon process is present afterwards while it finishes coming up.
    let liveCalls = 0;
    const liveSpy = spyOn(manager, "findLiveDaemonProcesses").mockImplementation(() => {
      liveCalls++;
      return liveCalls <= 1 ? [] : [999999];
    });
    // Our own launch never reports ready — our child dies first.
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {}),
    );
    // The peer publishes its socket shortly after our child exited: the inode
    // appears and the readiness probe starts succeeding.
    fakeTimer.setTimeout(() => {
      peerSocketReady = true;
      writeFileSync(socketPath, "peer socket placeholder");
    }, 500);

    try {
      await expect(manager.start()).resolves.toBeUndefined();
      expect(clients.some((client) => client.connectCallCount > 0)).toBe(true);
      // We must never terminate the peer daemon we joined.
      expect(spawner.process.signals).toEqual([]);
    } finally {
      readySpy.mockRestore();
      liveSpy.mockRestore();
    }
  });

  test("still fails promptly when no peer daemon is coming up after our subprocess exits (#6103)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    const spawner = new FakeDaemonSpawner();
    spawner.logText = "fatal startup error\nSQLITE_BUSY: database is locked\n";
    spawner.onSpawn = (process) => process.emit("exit", 1, null);

    const manager = new DaemonManager(
      () => new ProbeClient(false),
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
    );
    // No socket inode is created and no live daemon exists, so nothing is coming up.
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {}),
    );

    try {
      await expect(manager.start()).rejects.toThrow(
        /Daemon subprocess exited before becoming ready \(exit code 1\)[\s\S]*SQLITE_BUSY: database is locked/,
      );
      // The genuine failure surfaces without arming any polling timer (no hang).
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      expect(fakeTimer.getPendingSleepCount()).toBe(0);
    } finally {
      readySpy.mockRestore();
      findSpy.mockRestore();
    }
  });

  test("fails promptly when only an orphaned socket inode remains after our subprocess exits (#6103)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    const spawner = new FakeDaemonSpawner();
    spawner.logText = "fatal startup error\nSQLITE_BUSY: database is locked\n";
    // A race winner bound the socket then died right after, leaving an orphaned
    // socket inode with no listener — and our own child then exits 1.
    spawner.onSpawn = (process) => {
      writeFileSync(socketPath, "orphaned socket placeholder");
      process.emit("exit", 1, null);
    };

    const manager = new DaemonManager(
      // No listener: every readiness probe refuses to connect.
      () => new ProbeClient(false),
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
    );
    // No live daemon process backs the orphaned socket, so nothing is coming up.
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {}),
    );

    try {
      await expect(manager.start()).rejects.toThrow(
        /Daemon subprocess exited before becoming ready \(exit code 1\)[\s\S]*SQLITE_BUSY: database is locked/,
      );
      // The bare inode must NOT hold the reachability budget: no probe backoff and
      // no poll sleep are armed, so the failure is prompt (#5878/#5904).
      expect(existsSync(socketPath)).toBe(true);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      expect(fakeTimer.getPendingSleepCount()).toBe(0);
    } finally {
      readySpy.mockRestore();
      findSpy.mockRestore();
    }
  });

  test("skips the peer rejoin when the original start deadline is exhausted, so the diagnostic beats the client deadline (#6103)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const spawner = new FakeDaemonSpawner();
    spawner.logText = "fatal startup error\nSQLITE_BUSY: database is locked\n";
    // A socket inode and a live peer process both remain after our launch, so the
    // rejoin's own gate would let it run — a FRESH-budget rejoin would probe the
    // socket (populating `clients`). The ONLY reason nothing gets probed must be the
    // exhausted deadline.
    spawner.onSpawn = () => {
      writeFileSync(socketPath, "peer socket placeholder");
    };

    const clients: ProbeClient[] = [];
    const manager = new DaemonManager(
      () => {
        // Never becomes ready, so start() still rejects; whether it is even
        // constructed is the discriminator for "did the rejoin run".
        const client = new ProbeClient(false);
        clients.push(client);
        return client;
      },
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
    );
    // A live peer daemon process remains present after our launch.
    let liveCalls = 0;
    const liveSpy = spyOn(manager, "findLiveDaemonProcesses").mockImplementation(() => {
      liveCalls++;
      return liveCalls <= 1 ? [] : [999999];
    });
    // Our own launch burns the entire client-facing startup budget, then times out.
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(async () => {
      await fakeTimer.sleep(DAEMON_STARTUP_TIMEOUT_MS + 1);
      return false;
    });

    try {
      await expect(manager.start()).rejects.toThrow(/Daemon failed to start within \d+ms/);
      // Rejoin skipped: no readiness probe ran, so no fresh reachability wait was
      // armed after the budget was already spent — the diagnostic is not pushed past
      // the client deadline (#5878/#5904).
      expect(clients).toHaveLength(0);
      expect(spawner.process.signals).toEqual(["SIGTERM"]);
    } finally {
      readySpy.mockRestore();
      liveSpy.mockRestore();
    }
  });

  test("probes and joins a Windows named-pipe peer that has no filesystem socket entry (#6103)", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const { lockPath, pidPath, socketPath } = createPaths();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const spawner = new FakeDaemonSpawner();
      // Our child loses the race and exits 1; the peer is a reachable Windows named
      // pipe with NO filesystem entry (writeFileSync is never called for socketPath).
      spawner.onSpawn = (daemonProcess) => daemonProcess.emit("exit", 1, null);

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
        spawner,
      );
      let liveCalls = 0;
      const liveSpy = spyOn(manager, "findLiveDaemonProcesses").mockImplementation(() => {
        liveCalls++;
        return liveCalls <= 1 ? [] : [999999];
      });
      const readySpy = spyOn(manager, "waitForReady").mockImplementation(
        () => new Promise<boolean>(() => {}),
      );

      try {
        // No filesystem socket entry exists, yet the reachable named-pipe peer must
        // still be probed and joined rather than waited out (the existsSync gate would
        // be permanently false on Windows).
        expect(existsSync(socketPath)).toBe(false);
        await expect(manager.start()).resolves.toBeUndefined();
        expect(clients.some((client) => client.connectCallCount > 0)).toBe(true);
        expect(spawner.process.signals).toEqual([]);
      } finally {
        readySpy.mockRestore();
        liveSpy.mockRestore();
      }
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  test("preserves the original spawn-exit diagnostic when peer discovery fails during recovery (#6103)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    const spawner = new FakeDaemonSpawner();
    spawner.logText = "fatal startup error\nSQLITE_BUSY: database is locked\n";
    spawner.onSpawn = (daemonProcess) => daemonProcess.emit("exit", 1, null);

    const manager = new DaemonManager(
      () => new ProbeClient(false),
      undefined,
      fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
    );
    // Pre-spawn inspection succeeds (empty, so we spawn), but the recovery-path
    // inspection throws transiently.
    let findCalls = 0;
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockImplementation(() => {
      findCalls++;
      if (findCalls <= 1) {
        return [];
      }
      throw new Error("Failed to inspect daemon process table: ps exploded");
    });
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {}),
    );

    try {
      const surfaced = await manager.start().then(
        () => {
          throw new Error("start should have rejected");
        },
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      // The original spawn-exit diagnostic (with its captured log excerpt) is surfaced,
      // NOT the recovery-path inspection failure.
      expect(surfaced).toMatch(/Daemon subprocess exited before becoming ready \(exit code 1\)/);
      expect(surfaced).toContain("SQLITE_BUSY: database is locked");
      expect(surfaced).not.toContain("Failed to inspect daemon process table");
      // Recovery gave up immediately on the inspection failure — no poll armed.
      expect(fakeTimer.getPendingSleepCount()).toBe(0);
    } finally {
      readySpy.mockRestore();
      findSpy.mockRestore();
    }
  });

  test("spawn failures preserve the raw spawn error", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const spawner = new FakeDaemonSpawner();
    spawner.onSpawn = (process) => {
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
      spawner,
    );
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {}),
    );

    try {
      await expect(manager.start()).rejects.toThrow(
        /Daemon subprocess failed to spawn: spawn \/bin\/sh ENOENT/,
      );
    } finally {
      readySpy.mockRestore();
      findSpy.mockRestore();
    }
  });
});
