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
import type { DaemonSocketReachabilityLike } from "../../src/daemon/daemonSocketReachability";
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

/**
 * Injected fake for the observation-only peer-reachability probe (issue #6103), so the
 * rejoin loop (socket-first join, process gate, deadline headroom) can be driven
 * deterministically without a real socket — and so the REAL probe path is never armed
 * with a real 1s timer under a FakeTimer. `reachable` decides each probe's result;
 * `calls` records how many probes ran (0 proves the rejoin was skipped).
 */
class FakePeerSocketReachability implements DaemonSocketReachabilityLike {
  reachable: () => boolean = () => false;
  calls = 0;

  isReachable(_socketPath: string, _timeoutMs: number): Promise<boolean> {
    this.calls++;
    return Promise.resolve(this.reachable());
  }
}

/**
 * Constructs a DaemonManager with the injected peer-reachability probe at its
 * constructor position, keeping the rejoin tests readable despite the long signature.
 */
function createRejoinManager(args: {
  timer: FakeTimer;
  lockPath: string;
  pidPath: string;
  socketPath: string;
  spawner: FakeDaemonSpawner;
  reachability: DaemonSocketReachabilityLike;
}): DaemonManager {
  return new DaemonManager(
    undefined,
    undefined,
    args.timer,
    args.lockPath,
    args.pidPath,
    args.socketPath,
    args.spawner,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    args.reachability,
  );
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

  // BRICK regression guard (issue #6140, field-confirmed dogfood repro): a LIVE
  // daemon under load (busy accept queue, a concurrent heavy operation) can fail
  // every readiness probe attempt within budget while still genuinely owning the
  // socket. The prior behavior unlinked the socket whenever `status()` reported
  // the recorded PID alive after every probe attempt failed — which is exactly
  // this scenario, not just the rare "SIGKILL + PID reuse" case it was meant for.
  // Deleting a live daemon's socket, combined with the #5253 guard (which then
  // refuses to replace a daemon it believes is alive), permanently bricks every
  // later client until an explicit `--daemon restart`. This test fails on `main`
  // and passes after the fix: the socket must survive.
  test("never unlinks the socket when the readiness probe fails but the PID is alive (#6140)", async () => {
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
    // The probe is retried before giving up, bounded by the remaining readiness
    // deadline. A slow probe can consume the remaining budget before every retry
    // runs.
    expect(clients.length).toBeGreaterThan(0);
    expect(clients.length).toBeLessThanOrEqual(READINESS_PROBE_MAX_ATTEMPTS);
    expect(clients[0].connectCallCount).toBe(1);
    expect(clients[0].closeCallCount).toBe(1);
    // The live daemon's socket must NOT be unlinked (issue #6140).
    expect(existsSync(socketPath)).toBe(true);
  });

  // Same BRICK regression (#6140), against a genuine Unix socket inode rather than
  // a placeholder file — the case the removed `isSocket()`-bypassing cleanup used
  // to specifically target. The probe still cannot complete the daemon handshake,
  // but the recorded PID is alive, so the inode must be preserved rather than
  // unlinked out from under the live process bound to it.
  // Gated off Windows: net.Server.listen(path) there means a named pipe, not a
  // filesystem socket inode, so a real socket inode cannot be created this way.
  test.skipIf(process.platform === "win32")(
    "never unlinks a live socket inode when the readiness probe cannot connect (#6140)",
    async () => {
      const { lockPath, pidPath, socketPath } = createPaths();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const clients: ProbeClient[] = [];
      writePidFile(pidPath, socketPath);

      // Bind a real Unix socket so the path is a genuine socket inode. The probe
      // still fails because it cannot complete the daemon handshake, but the
      // recorded PID is genuinely alive throughout, so the inode must survive.
      // Left listening for afterEach cleanup; closing here would unlink the inode
      // itself.
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
      expect(existsSync(socketPath)).toBe(true);
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

  test("joins a peer daemon that becomes reachable just after our subprocess exits (#6103)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const spawner = new FakeDaemonSpawner();
    // Our spawned child loses the socket-ownership race and exits 1.
    spawner.onSpawn = (daemonProcess) => daemonProcess.emit("exit", 1, null);

    // The peer's listener only starts accepting a beat later: the observation-only
    // socket probe is refused the first time and reachable on the second.
    const reachability = new FakePeerSocketReachability();
    reachability.reachable = () => reachability.calls >= 2;
    const manager = createRejoinManager({
      timer: fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
      reachability,
    });

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

    try {
      await expect(manager.start()).resolves.toBeUndefined();
      expect(reachability.calls).toBeGreaterThanOrEqual(2);
      // We must never terminate the peer daemon we joined.
      expect(spawner.process.signals).toEqual([]);
      // The synchronous process scan runs once pre-spawn and once in the rejoin (after
      // the first probe miss) — NOT on every poll iteration (issue #6103). The join
      // completes within the coarse re-scan interval, so exactly two scans occur.
      expect(liveCalls).toBe(2);
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
    spawner.onSpawn = (daemonProcess) => daemonProcess.emit("exit", 1, null);

    const reachability = new FakePeerSocketReachability(); // socket never reachable
    const manager = createRejoinManager({
      timer: fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
      reachability,
    });
    // No live daemon exists, so nothing is coming up.
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {}),
    );

    try {
      await expect(manager.start()).rejects.toThrow(
        /Daemon subprocess exited before becoming ready \(exit code 1\)[\s\S]*SQLITE_BUSY: database is locked/,
      );
      // Socket unreachable and no live peer process: fails without arming any polling
      // timer (no hang).
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      expect(fakeTimer.getPendingSleepCount()).toBe(0);
    } finally {
      readySpy.mockRestore();
      findSpy.mockRestore();
    }
  });

  test("probes the socket BEFORE the process scan and joins without scanning when it answers (#6103)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const spawner = new FakeDaemonSpawner();
    spawner.onSpawn = (daemonProcess) => daemonProcess.emit("exit", 1, null);

    // The peer is already accepting on the socket.
    const reachability = new FakePeerSocketReachability();
    reachability.reachable = () => true;
    const manager = createRejoinManager({
      timer: fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
      reachability,
    });
    // The (synchronous, possibly-stalling) process scan must never run before the
    // authoritative socket probe. Count every scan; with a reachable socket the rejoin
    // must join on the probe and never scan, so only the single pre-spawn scan occurs.
    let scanCalls = 0;
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockImplementation(() => {
      scanCalls++;
      return [];
    });
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {}),
    );

    try {
      await expect(manager.start()).resolves.toBeUndefined();
      expect(reachability.calls).toBeGreaterThanOrEqual(1);
      // Exactly one scan (the pre-spawn reuse check); the rejoin joined via the probe
      // without ever consulting the scan — proving socket-first ordering.
      expect(scanCalls).toBe(1);
      expect(spawner.process.signals).toEqual([]);
    } finally {
      readySpy.mockRestore();
      findSpy.mockRestore();
    }
  });

  test("does one final socket probe before abandoning when the scan misses a just-published peer (#6103)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const spawner = new FakeDaemonSpawner();
    spawner.onSpawn = (daemonProcess) => daemonProcess.emit("exit", 1, null);

    // The peer publishes its socket right after the first probe: reachable only on the
    // SECOND probe, which is the final probe taken after the (missing) scan.
    const reachability = new FakePeerSocketReachability();
    reachability.reachable = () => reachability.calls >= 2;
    const manager = createRejoinManager({
      timer: fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
      reachability,
    });
    // The best-effort process scan misses the peer entirely (returns empty). Without a
    // final probe, the rejoin would abandon on this snapshot even though the winner is
    // now accepting.
    const findSpy = spyOn(manager, "findAllDaemonProcesses").mockReturnValue([]);
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {}),
    );

    try {
      await expect(manager.start()).resolves.toBeUndefined();
      // Two probes: the first (miss) and the final probe after the empty scan (join).
      expect(reachability.calls).toBe(2);
      expect(spawner.process.signals).toEqual([]);
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

    // A reachable peer would be joined if probed — the ONLY reason nothing gets probed
    // must be the exhausted deadline.
    const reachability = new FakePeerSocketReachability();
    reachability.reachable = () => true;
    const manager = createRejoinManager({
      timer: fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
      reachability,
    });
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
      // Rejoin skipped: the socket was never probed, so no fresh reachability wait was
      // armed after the budget was already spent (#5878/#5904).
      expect(reachability.calls).toBe(0);
      expect(spawner.process.signals).toEqual(["SIGTERM"]);
    } finally {
      readySpy.mockRestore();
      liveSpy.mockRestore();
    }
  });

  test("reserves delivery headroom: skips the near-deadline rejoin so the diagnostic beats the deadline (#6103)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const spawner = new FakeDaemonSpawner();
    spawner.logText = "fatal startup error\nSQLITE_BUSY: database is locked\n";
    // Our child exits only near the deadline: it burns all but ~1s of the ~30s start
    // budget, then exits 1. Scheduling the exit inside onSpawn (after the spawn is wired
    // up) keeps ordering deterministic. This leaves a SMALL positive remainder under the
    // start deadline — less than the delivery headroom — at the point of the rejoin.
    spawner.onSpawn = (daemonProcess) => {
      fakeTimer.setTimeout(
        () => daemonProcess.emit("exit", 1, null),
        DAEMON_STARTUP_TIMEOUT_MS - 1000,
      );
    };

    // The socket never becomes reachable, and a live peer process is present — so a
    // rejoin that ran would poll out its remaining budget and rethrow AT the deadline.
    const reachability = new FakePeerSocketReachability();
    const manager = createRejoinManager({
      timer: fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
      reachability,
    });
    let liveCalls = 0;
    const liveSpy = spyOn(manager, "findLiveDaemonProcesses").mockImplementation(() => {
      liveCalls++;
      return liveCalls <= 1 ? [] : [999999];
    });
    // Our launch never reports ready on its own — the delayed child exit is what ends it.
    const readySpy = spyOn(manager, "waitForReady").mockImplementation(
      () => new Promise<boolean>(() => {}),
    );

    try {
      await expect(manager.start()).rejects.toThrow(
        /Daemon subprocess exited before becoming ready \(exit code 1\)[\s\S]*SQLITE_BUSY: database is locked/,
      );
      // Skipped even though positive time remained (unlike the fully-exhausted case),
      // because that remainder was below the delivery-headroom reserve — so the
      // diagnostic is delivered with headroom rather than raced against the deadline.
      expect(reachability.calls).toBe(0);
    } finally {
      readySpy.mockRestore();
      liveSpy.mockRestore();
    }
  });

  test("preserves the original spawn-exit diagnostic when peer discovery fails during recovery (#6103)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    const spawner = new FakeDaemonSpawner();
    spawner.logText = "fatal startup error\nSQLITE_BUSY: database is locked\n";
    spawner.onSpawn = (daemonProcess) => daemonProcess.emit("exit", 1, null);

    const reachability = new FakePeerSocketReachability(); // socket not reachable
    const manager = createRejoinManager({
      timer: fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner,
      reachability,
    });
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
      // Recovery gave up without arming a poll after the inspection failure.
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

  // Platform-aware readiness (issue #6140): a Windows named pipe has no
  // filesystem entry, so gating on `existsSync(this.socketPath)` before probing
  // means a joined (or normally-started) Windows daemon can never be observed and
  // `waitForReady` always times out. Simulate win32 via the injected platform
  // override rather than a real OS switch.
  test("waitForReady probes the socket on win32 even though it has no filesystem entry (#6140)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const clients: ProbeClient[] = [];
    // Deliberately do NOT create a file at socketPath: a named pipe has none.

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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "win32",
    );

    await expect(manager.waitForReady(100)).resolves.toBe(true);
    expect(clients).toHaveLength(1);
    expect(existsSync(socketPath)).toBe(false);
  });

  // Regression companion: the default (non-win32) platform must keep requiring an
  // observable socket path before probing.
  test("waitForReady still gates on existsSync off win32", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const clients: ProbeClient[] = [];
    // No file at socketPath and no explicit platform override (defaults to the
    // real, non-win32 test platform).

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

    await expect(manager.waitForReady(100)).resolves.toBe(false);
    expect(clients).toHaveLength(0);
  });

  // #6109-folded fix (a): the process-table scan is a synchronous, uncancellable
  // `ps`/PowerShell call with no timeout of its own. Once the rejoin budget is
  // exhausted, the loop must return rather than start that scan.
  test("recheck the deadline before scanning the process table so an exhausted budget skips it (#6140, folded from PR #6109)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Consumes the ENTIRE probe budget handed to it before reporting a miss, so
    // the rejoin deadline is exactly exhausted right as the process-table scan
    // would otherwise run.
    class BudgetExhaustingReachability implements DaemonSocketReachabilityLike {
      calls = 0;
      constructor(private readonly timer: FakeTimer) {}
      async isReachable(_socketPath: string, timeoutMs: number): Promise<boolean> {
        this.calls++;
        await this.timer.sleep(timeoutMs);
        return false;
      }
    }
    const reachability = new BudgetExhaustingReachability(fakeTimer);
    const manager = createRejoinManager({
      timer: fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner: new FakeDaemonSpawner(),
      reachability,
    });

    let scanCalls = 0;
    const liveSpy = spyOn(manager, "findLiveDaemonProcesses").mockImplementation(() => {
      scanCalls++;
      return [];
    });

    try {
      const internals = manager as unknown as {
        tryJoinPeerDaemonAfterSpawnExit(budgetMs: number): Promise<boolean>;
      };
      // Budget equals the single-probe cap, so the first probe alone exhausts it.
      await expect(internals.tryJoinPeerDaemonAfterSpawnExit(1000)).resolves.toBe(false);
      expect(reachability.calls).toBe(1);
      // The scan must never run: the deadline was already exhausted by the probe.
      expect(scanCalls).toBe(0);
    } finally {
      liveSpy.mockRestore();
    }
  });

  // #6109-folded fix (b): findLiveDaemonProcesses() scans the WHOLE process table
  // and cannot tell a daemon bound to THIS namespace's socket apart from an
  // unrelated one (another worktree, another isolated test socket). For a manager
  // using an isolated (non-default) PID/socket path, the rejoin must not trust
  // that unscoped "a live daemon process exists somewhere" signal for the full
  // budget — an unrelated daemon being alive must not poll an unreachable socket
  // for the whole rejoin window.
  test("bounds the rejoin to a short grace for an isolated socket namespace, ignoring an unrelated daemon (#6140, folded from PR #6109)", async () => {
    const { lockPath, pidPath, socketPath } = createPaths();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    const reachability = new FakePeerSocketReachability(); // never reachable
    const manager = createRejoinManager({
      timer: fakeTimer,
      lockPath,
      pidPath,
      socketPath,
      spawner: new FakeDaemonSpawner(),
      reachability,
    });
    // An unrelated auto-mobile daemon (a different worktree/namespace) is always
    // "live" per the unscoped process-table scan.
    const liveSpy = spyOn(manager, "findLiveDaemonProcesses").mockReturnValue([424242]);

    try {
      const internals = manager as unknown as {
        tryJoinPeerDaemonAfterSpawnExit(budgetMs: number): Promise<boolean>;
      };
      const start = fakeTimer.getCurrentTime();
      // A generous budget that would, on the default namespace, poll for a long
      // time on the strength of the (unrelated) live-process signal alone.
      await expect(internals.tryJoinPeerDaemonAfterSpawnExit(30_000)).resolves.toBe(false);
      // Bounded to the short isolated-namespace grace, not the full 30s budget.
      expect(fakeTimer.getCurrentTime() - start).toBeLessThan(5_000);
    } finally {
      liveSpy.mockRestore();
    }
  });
});
