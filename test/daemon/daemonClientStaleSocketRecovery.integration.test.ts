import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { DaemonClient, STALE_SOCKET_RECOVERY_PROBE_MAX_ATTEMPTS } from "../../src/daemon/client";
import type { DaemonSocketReachabilityLike } from "../../src/daemon/daemonSocketReachability";
import type {
  SocketHolderProbe,
  SocketHolderProbeOptions,
} from "../../src/daemon/socketHolderProbe";
import type { PidFileData } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

const isWindows = platform() === "win32";

describe("DaemonClient stale socket recovery", () => {
  const tempDirs: string[] = [];
  let server: Server | null = null;

  function createTempPaths(): { dir: string; socketPath: string; pidFilePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-stale-socket-test-"));
    tempDirs.push(dir);
    return {
      dir,
      socketPath: join(dir, "daemon.sock"),
      pidFilePath: join(dir, "daemon.pid"),
    };
  }

  async function createClosedSocketFile(socketPath: string): Promise<void> {
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }

  function writePidFile(pidFilePath: string, socketPath: string): void {
    const pidData: PidFileData = {
      pid: 12345,
      socketPath,
      port: 3000,
      startedAt: 0,
      version: "test",
    };
    writeFileSync(pidFilePath, JSON.stringify(pidData));
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  (isWindows ? test.skip : test)(
    "isAvailable removes socket and PID files when the recorded daemon PID is dead",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "stale socket placeholder");
      writePidFile(pidFilePath, socketPath);

      const available = await DaemonClient.isAvailable(socketPath, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => false,
      });

      expect(available).toBe(false);
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(pidFilePath)).toBe(false);
    },
  );

  (isWindows ? test.skip : test)(
    "isAvailable leaves files intact when the recorded daemon PID is alive",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "stale socket placeholder");
      writePidFile(pidFilePath, socketPath);

      const available = await DaemonClient.isAvailable(socketPath, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => true,
      });

      expect(available).toBe(false);
      expect(existsSync(socketPath)).toBe(true);
      expect(existsSync(pidFilePath)).toBe(true);
    },
  );

  (isWindows ? test.skip : test)(
    "connect cleans stale files and retries after a failed socket connection",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      await createClosedSocketFile(socketPath);
      writePidFile(pidFilePath, socketPath);

      const client = new DaemonClient(socketPath, 50, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => false,
      });

      await expect(client.connect()).rejects.toThrow("Daemon socket not found");
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(pidFilePath)).toBe(false);
    },
  );
});

describe("DaemonClient stale socket recovery — winner-race reachability guard (#6140)", () => {
  const tempDirs: string[] = [];

  function createTempPaths(): { dir: string; socketPath: string; pidFilePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-winner-race-test-"));
    tempDirs.push(dir);
    return {
      dir,
      socketPath: join(dir, "daemon.sock"),
      pidFilePath: join(dir, "daemon.pid"),
    };
  }

  function writePidFile(pidFilePath: string, socketPath: string): void {
    const pidData: PidFileData = {
      pid: 12345,
      socketPath,
      port: 3000,
      startedAt: 0,
      version: "test",
    };
    writeFileSync(pidFilePath, JSON.stringify(pidData));
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  (isWindows ? test.skip : test)(
    "propagates the original error instead of unlinking when the reachability probe reports a live peer",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      // No listener at all: connectOnce's real attempt fails (ENOENT/ECONNREFUSED).
      writePidFile(pidFilePath, socketPath);

      let cleanupCalls = 0;
      class AlwaysReachable implements DaemonSocketReachabilityLike {
        async isReachable(): Promise<boolean> {
          return true;
        }
      }

      const client = new DaemonClient(socketPath, 50, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        // The recorded PID is dead — the OLD guard alone would consider this
        // stale and unlink.
        isProcessRunning: () => {
          cleanupCalls++;
          return false;
        },
        reachability: new AlwaysReachable(),
      });

      await expect(client.connect()).rejects.toThrow();
      // The reachability probe reporting "live" must short-circuit BEFORE the
      // dead-PID cleanup ever runs.
      expect(cleanupCalls).toBe(0);
      expect(existsSync(pidFilePath)).toBe(true);
    },
  );

  // The whole point of #6140 is to never unlink a live winner's socket. A SINGLE
  // negative probe is not authoritative: a full accept backlog or a transient
  // refusal can make a live winner's socket look momentarily unreachable. This
  // fake fails the first probe, then reports the (live) winner reachable on the
  // second — recovery must never unlink on that one transient miss.
  (isWindows ? test.skip : test)(
    "does not unlink a live winner's socket after one transient probe failure, even with a dead-loser PID",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "live winner socket placeholder");
      writePidFile(pidFilePath, socketPath);

      let calls = 0;
      class TransientThenReachable implements DaemonSocketReachabilityLike {
        async isReachable(): Promise<boolean> {
          calls++;
          // First probe: transient miss (e.g. a full accept backlog). Second probe:
          // the live winner answers.
          return calls >= 2;
        }
      }

      let cleanupCalls = 0;
      const client = new DaemonClient(socketPath, 500, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        // The recorded PID is dead — the OLD single-probe guard would have unlinked
        // on the first (transient) negative probe.
        isProcessRunning: () => {
          cleanupCalls++;
          return false;
        },
        reachability: new TransientThenReachable(),
      });

      await expect(client.connect()).rejects.toThrow();
      expect(calls).toBeGreaterThanOrEqual(2);
      // The dead-PID cleanup must never run once ANY probe in the sequence reports
      // a live winner.
      expect(cleanupCalls).toBe(0);
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    },
  );

  // #6140 P2 review finding: the multi-probe confirmation rechecks ABORT after
  // each await but must also recheck the DEADLINE after the FINAL probe. When
  // that last probe is capped to the last remaining milliseconds and resolves
  // exactly AT the deadline, the loop must not fall through to an unconditional
  // "confirmed unreachable" — that would let connect() run the dead-PID unlink
  // AFTER its own advertised timeout, potentially deleting a live winner's
  // socket a slower, still-in-flight retry would have found reachable.
  (isWindows ? test.skip : test)(
    "does not confirm unreachable when the final probe consumes the entire remaining deadline",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "live winner socket placeholder");
      writePidFile(pidFilePath, socketPath);

      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      class ExactBudgetOnFinalAttempt implements DaemonSocketReachabilityLike {
        calls = 0;
        constructor(private readonly timer: FakeTimer) {}
        async isReachable(_socketPath: string, timeoutMs: number): Promise<boolean> {
          this.calls++;
          if (this.calls < STALE_SOCKET_RECOVERY_PROBE_MAX_ATTEMPTS) {
            // Earlier attempts resolve instantly, leaving the full budget for the
            // final attempt below.
            return false;
          }
          // Final attempt: consume the ENTIRE supplied (deadline-capped) timeout,
          // landing this.timer.now() exactly AT the deadline.
          await this.timer.sleep(timeoutMs);
          return false;
        }
      }
      const reachability = new ExactBudgetOnFinalAttempt(fakeTimer);

      let cleanupCalls = 0;
      const client = new DaemonClient(socketPath, 300, fakeTimer, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => {
          cleanupCalls++;
          return false;
        },
        reachability,
      });

      await expect(client.connect()).rejects.toThrow();
      expect(reachability.calls).toBe(STALE_SOCKET_RECOVERY_PROBE_MAX_ATTEMPTS);
      // Running out of budget exactly as the last probe resolves must NEVER be
      // treated as confirmation — the dead-PID cleanup must not run.
      expect(cleanupCalls).toBe(0);
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    },
  );

  (isWindows ? test.skip : test)(
    "still cleans up and retries when the reachability probe reports nothing live",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "stale socket placeholder");
      writePidFile(pidFilePath, socketPath);

      class NeverReachable implements DaemonSocketReachabilityLike {
        async isReachable(): Promise<boolean> {
          return false;
        }
      }
      // No live process holds this path — the authoritative check confirms it.
      // Injected (rather than relying on the real `lsof`-backed default) so this
      // stays a fast, deterministic unit test with no real subprocess dependency.
      class NoHolder implements SocketHolderProbe {
        async getHolderPids(): Promise<number[]> {
          return [];
        }
      }

      const client = new DaemonClient(socketPath, 50, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => false,
        reachability: new NeverReachable(),
        socketHolderProbe: new NoHolder(),
      });

      await expect(client.connect()).rejects.toThrow("Daemon socket not found");
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(pidFilePath)).toBe(false);
    },
  );

  // #6140 P1 re-raised: a fixed reachability-probe count is a HEURISTIC, not
  // authoritative ownership proof. A full accept backlog or a slow accept can
  // make every probe fail even while a live winner genuinely owns the socket —
  // exactly this scenario. The unlink must additionally be gated on the
  // AUTHORITATIVE socket-holder check; when that check finds a live PID, recovery
  // must stay non-destructive regardless of how many probes failed.
  (isWindows ? test.skip : test)(
    "does not unlink when every reachability probe fails but the authoritative holder check finds a live winner (accept-backlog scenario)",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "live winner socket placeholder");
      writePidFile(pidFilePath, socketPath);

      class NeverReachable implements DaemonSocketReachabilityLike {
        calls = 0;
        async isReachable(): Promise<boolean> {
          this.calls++;
          // Every reachability probe fails — e.g. a full accept backlog — even
          // though a live winner genuinely holds the socket.
          return false;
        }
      }
      const reachability = new NeverReachable();

      class LiveHolder implements SocketHolderProbe {
        calls = 0;
        async getHolderPids(): Promise<number[]> {
          this.calls++;
          return [777777]; // the live winner's PID
        }
      }
      const holderProbe = new LiveHolder();

      let cleanupCalls = 0;
      const client = new DaemonClient(socketPath, 500, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        // The recorded PID is dead — the probe-count-only guard would have
        // unlinked here once every reachability probe failed.
        isProcessRunning: () => {
          cleanupCalls++;
          return false;
        },
        reachability,
        socketHolderProbe: holderProbe,
      });

      await expect(client.connect()).rejects.toThrow();
      expect(reachability.calls).toBe(STALE_SOCKET_RECOVERY_PROBE_MAX_ATTEMPTS);
      // The heuristic escalated to the authoritative check exactly once...
      expect(holderProbe.calls).toBe(1);
      // ...which found a live holder, so the dead-PID cleanup must never run.
      expect(cleanupCalls).toBe(0);
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    },
  );

  // Same accept-backlog scenario, but the authoritative check itself cannot
  // determine ownership (e.g. `lsof` missing/erroring). An inconclusive result
  // must be treated the same as "a live holder exists" — never grounds to unlink.
  (isWindows ? test.skip : test)(
    "does not unlink when the authoritative holder check is inconclusive",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "socket placeholder");
      writePidFile(pidFilePath, socketPath);

      class NeverReachable implements DaemonSocketReachabilityLike {
        async isReachable(): Promise<boolean> {
          return false;
        }
      }

      class InconclusiveHolder implements SocketHolderProbe {
        calls = 0;
        async getHolderPids(): Promise<number[] | undefined> {
          this.calls++;
          return undefined;
        }
      }
      const holderProbe = new InconclusiveHolder();

      let cleanupCalls = 0;
      const client = new DaemonClient(socketPath, 500, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => {
          cleanupCalls++;
          return false;
        },
        reachability: new NeverReachable(),
        socketHolderProbe: holderProbe,
      });

      await expect(client.connect()).rejects.toThrow();
      expect(holderProbe.calls).toBe(1);
      expect(cleanupCalls).toBe(0);
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    },
  );

  // #6140 P2: the holder-probe await must be bounded by the caller's remaining
  // `connect(timeoutMs)` budget and cancellable via its AbortSignal — otherwise a
  // stalled `lsof` could keep this attempt (and the underlying process) pending
  // indefinitely past both the deadline and any cancellation. A probe that
  // consumes its entire bounded budget and then reports it could not complete
  // (the real `LsofSocketHolderProbe`'s own timeout/abort handling surfaces this
  // as `undefined`) must be treated as inconclusive — never grounds to unlink.
  (isWindows ? test.skip : test)(
    "does not unlink when the authoritative holder probe stalls past its bounded budget",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "socket placeholder");
      writePidFile(pidFilePath, socketPath);

      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      class NeverReachable implements DaemonSocketReachabilityLike {
        async isReachable(): Promise<boolean> {
          return false;
        }
      }

      class StallingHolder implements SocketHolderProbe {
        calls = 0;
        receivedOptions: SocketHolderProbeOptions[] = [];
        constructor(private readonly timer: FakeTimer) {}
        async getHolderPids(
          _socketPath: string,
          options: SocketHolderProbeOptions = {},
        ): Promise<number[] | undefined> {
          this.calls++;
          this.receivedOptions.push(options);
          // Simulate a stalled `lsof`: consume the ENTIRE bounded budget it was
          // given, then report inconclusive — mirroring what
          // `LsofSocketHolderProbe`'s own exec-seam timeout handling would surface.
          await this.timer.sleep(options.timeoutMs ?? 0);
          return undefined;
        }
      }
      const holderProbe = new StallingHolder(fakeTimer);

      let cleanupCalls = 0;
      const client = new DaemonClient(socketPath, 300, fakeTimer, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => {
          cleanupCalls++;
          return false;
        },
        reachability: new NeverReachable(),
        socketHolderProbe: holderProbe,
      });

      await expect(client.connect()).rejects.toThrow();
      expect(holderProbe.calls).toBe(1);
      // The probe must have been given a bounded, finite budget — never left
      // unbounded.
      expect(holderProbe.receivedOptions[0]?.timeoutMs).toBeGreaterThan(0);
      expect(holderProbe.receivedOptions[0]?.timeoutMs).toBeLessThan(Number.POSITIVE_INFINITY);
      expect(cleanupCalls).toBe(0);
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    },
  );

  // #6140 P2: even a CONFIRMED-empty holder result must not authorize the unlink
  // if it arrives after connect()'s own deadline has already passed — otherwise
  // the unlink could run past the caller's advertised timeout, the exact
  // regression class this PR exists to prevent.
  (isWindows ? test.skip : test)(
    "does not unlink when the holder probe resolves empty only after the deadline has passed",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "socket placeholder");
      writePidFile(pidFilePath, socketPath);

      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      class NeverReachable implements DaemonSocketReachabilityLike {
        async isReachable(): Promise<boolean> {
          return false;
        }
      }

      class LateEmptyHolder implements SocketHolderProbe {
        calls = 0;
        constructor(private readonly timer: FakeTimer) {}
        async getHolderPids(
          _socketPath: string,
          options: SocketHolderProbeOptions = {},
        ): Promise<number[]> {
          this.calls++;
          // Consume the entire bounded budget it was given, landing exactly AT the
          // deadline, then report a CONFIRMED empty result — too late to act on.
          await this.timer.sleep(options.timeoutMs ?? 0);
          return [];
        }
      }
      const holderProbe = new LateEmptyHolder(fakeTimer);

      let cleanupCalls = 0;
      const client = new DaemonClient(socketPath, 300, fakeTimer, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => {
          cleanupCalls++;
          return false;
        },
        reachability: new NeverReachable(),
        socketHolderProbe: holderProbe,
      });

      await expect(client.connect()).rejects.toThrow();
      expect(holderProbe.calls).toBe(1);
      // The dead-PID cleanup must never run despite the CONFIRMED empty result:
      // it arrived only once the deadline had already passed.
      expect(cleanupCalls).toBe(0);
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    },
  );

  // The caller can abort WHILE the reachability probe from the fix above is
  // in flight. The pre-await `!signal?.aborted` check cannot see an abort that
  // happens during the awaited call, so the abort must be rechecked immediately
  // after it resolves — otherwise connect() would ignore the cancellation and
  // proceed to the dead-PID cleanup/retry anyway.
  (isWindows ? test.skip : test)(
    "bails without stale-socket cleanup when aborted while the reachability probe is pending",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      // No listener: connectOnce's real attempt fails quickly (ENOENT/ECONNREFUSED).
      writePidFile(pidFilePath, socketPath);

      class PendingReachability implements DaemonSocketReachabilityLike {
        calls = 0;
        private resolvers: Array<(value: boolean) => void> = [];
        isReachable(): Promise<boolean> {
          this.calls++;
          return new Promise((resolve) => {
            this.resolvers.push(resolve);
          });
        }
        resolveNext(value: boolean): void {
          this.resolvers.shift()?.(value);
        }
      }
      const reachability = new PendingReachability();

      let cleanupCalls = 0;
      const controller = new AbortController();
      const client = new DaemonClient(socketPath, 500, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => {
          cleanupCalls++;
          return false;
        },
        reachability,
      });

      const connectPromise = client.connect(500, controller.signal);

      // Wait until connect() has entered the recovery probe (deterministic:
      // poll the fake's call counter rather than a fixed sleep).
      while (reachability.calls === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Abort WHILE the probe is still pending, then let it resolve.
      controller.abort();
      reachability.resolveNext(false);

      await expect(connectPromise).rejects.toThrow();
      // The abort must be rechecked after the probe settles: cleanup (and any
      // retried connectOnce) must never run once the caller has cancelled.
      expect(cleanupCalls).toBe(0);
      expect(existsSync(pidFilePath)).toBe(true);
    },
  );
});

describe("DaemonClient platform-aware connect (#6140)", () => {
  const tempDirs: string[] = [];

  function createTempPidPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "daemon-client-platform-test-"));
    tempDirs.push(dir);
    return join(dir, "daemon.pid");
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("does not gate connectOnce on existsSync when simulating win32 (named pipes have no filesystem entry)", async () => {
    // A path that does not exist on disk — modeling a Windows named pipe, which
    // never has a filesystem entry to begin with.
    const nonExistentSocketPath = join(
      tmpdir(),
      `daemon-client-win32-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );
    const pidFilePath = createTempPidPath(); // no PID file written: nothing to clean up

    const client = new DaemonClient(
      nonExistentSocketPath,
      100,
      undefined,
      { pidFilePath, socketPaths: [nonExistentSocketPath] },
      null,
      undefined,
      "win32",
    );

    const error: unknown = await client.connect().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    // The win32 branch skips the synchronous existsSync precheck entirely, so the
    // failure comes from the actual (failed) connection attempt, never from the
    // "Daemon socket not found" short-circuit that precheck would have produced.
    expect((error as Error).message).not.toContain("Daemon socket not found");
  });

  // Asserts the DEFAULT (unoverridden) platform still gates on existsSync, which
  // only holds when this host's real platform is not win32 — on the Windows
  // host-integration runner `platform()` genuinely IS "win32", so the gate this
  // test checks for would not apply and connectOnce would instead attempt (and
  // fail) a real connection rather than short-circuiting on the missing path.
  (isWindows ? test.skip : test)(
    "still throws the existsSync short-circuit off win32",
    async () => {
      const nonExistentSocketPath = join(
        tmpdir(),
        `daemon-client-posix-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
      );
      const pidFilePath = createTempPidPath();

      const client = new DaemonClient(nonExistentSocketPath, 100, undefined, {
        pidFilePath,
        socketPaths: [nonExistentSocketPath],
      });

      await expect(client.connect()).rejects.toThrow("Daemon socket not found");
    },
  );
});
