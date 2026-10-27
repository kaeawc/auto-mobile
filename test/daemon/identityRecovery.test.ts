import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import { spyOnPrivate } from "../helpers/spyOnPrivate";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recoveryOwnerSchema,
  republishOwnedIdentity,
  type IdentityRecoveryIO,
} from "../../src/daemon/identityRecovery";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { SafeDaemonManager as DaemonManager } from "../fakes/SafeDaemonManager";
import { executionTracker } from "../../src/daemon/executionTracker";
import { ActionableError } from "../../src/models";
import type { Session } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { createFakeSession } from "./helpers/inputSocketHarness";
import type {
  DaemonOptions,
  DaemonStatus,
  PidFileData,
  DaemonSocketPaths,
} from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { formatLockContent, parseLockContent } from "../../src/utils/fileLock";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { getCurrentBuildIdentity } from "../../src/daemon/wire/buildIdentity";
import { DAEMON_STARTUP_TIMEOUT_MS, DAEMON_VERSION } from "../../src/daemon/wire/constants";
import {
  DAEMON_REPUBLISH_IDENTITY_METHOD as REPUBLISH,
  DAEMON_PREPARE_MAINTENANCE_METHOD as PREPARE,
  DAEMON_RESTART_ADMITTED_METHOD as ADMIT,
} from "../../src/daemon/daemonRestartAdmission";

const socketPath = "/isolated/control.sock";
const sockets: DaemonSocketPaths = {
  control: socketPath,
  appearance: "/isolated/appearance.sock",
  "device-snapshot": "/isolated/snapshot.sock",
  "failures-push": "/isolated/fp.sock",
  "failures-stream": "/isolated/fs.sock",
  "observation-stream": "/isolated/os.sock",
  "performance-push": "/isolated/pp.sock",
  "performance-stream": "/isolated/ps.sock",
  "telemetry-push": "/isolated/tp.sock",
  "device-gesture-recording": "/isolated/tr.sock",
  "video-recording": "/isolated/vr.sock",
  "video-stream": "/isolated/vs.sock",
  "webrtc-stream": "/isolated/ws.sock",
};
const complete: PidFileData = {
  pid: 123,
  startedAt: 100,
  processStartedAt: 90,
  processGenerationToken: "generation-1",
  version: "1.0.0",
  buildId: "build-1",
  entryScript: "/isolated/index.ts",
  socketPath,
  sockets,
  dbPath: "/isolated/existing.db",
  daemonSessionId: "session-1",
  port: 19000,
  launchLogPath: null,
  options: { debug: true, port: 19000, host: "127.0.0.1" },
};

/** The replacement owner a status recovery names; the scenario must have produced one. */
function replacementOwnerOf(status: DaemonStatus): DaemonStatus {
  const owner = status.recovery?.replacementOwner;
  if (!owner) {
    throw new Error("expected the status recovery to name a replacement owner");
  }
  return owner;
}

function harness(
  result: { accepted: boolean; reason?: string } = { accepted: true },
  lockPath = "/isolated/lock",
  timer = new FakeTimer(),
) {
  let record: PidFileData | null = null;
  let owner: DaemonStatus = {
    ...complete,
    running: true,
    reportedPidFilePath: "/isolated/pid",
    reportedSocketPath: socketPath,
    reportedSockets: sockets,
  };
  let probeError: Error | undefined;
  const results = new Map<string, unknown>([
    [REPUBLISH, result],
    [PREPARE, { accepted: true, maintenanceToken: "token" }],
    [ADMIT, { accepted: true }],
  ]);
  const client = new FakeDaemonClient({
    daemonMethodResults: results,
    onCallDaemonMethod: async (method) => {
      if (method === REPUBLISH && result.accepted) {
        record = { ...complete };
      }
    },
  });
  if (lockPath === "/isolated/lock") {
    timer.enableAutoAdvance();
  }
  const manager = new DaemonManager({
    clientFactory: () => client,
    timer,
    lockFilePath: lockPath,
    pidFilePath: "/isolated/pid",
    socketPath,
    processFinder: {
      findDaemonProcesses: () => [],
      isProcessRunning: (pid) => pid === process.pid || (owner.running && pid === owner.pid),
    },
    processSignaler: {
      signal: () => {
        throw new Error("must not signal");
      },
    },
    platform: "linux",
    identityRecoveryIO: {
      socketExists: () => true,
      readRecord: () => record,
      probe: async () => {
        if (probeError) {
          throw probeError;
        }
        return owner;
      },
    },
  });
  return {
    manager,
    timer,
    client,
    results,
    get record() {
      return record;
    },
    setRecord: (value: PidFileData | null) => {
      record = value;
    },
    setOwner: (value: DaemonStatus) => {
      owner = {
        reportedPidFilePath: "/isolated/pid",
        reportedSocketPath: socketPath,
        reportedSockets: sockets,
        ...value,
      };
    },
    failProbe: (error: Error) => {
      probeError = error;
    },
  };
}

// Managers that start a (fake) daemon still open a launch log under the resolved
// AutoMobile data dir; keep it off the developer's real ~/.auto-mobile.
let isolatedDataDir: string;
let originalDataDir: string | undefined;

// CI's per-test time includes beforeEach/afterEach but not beforeAll/afterAll, so the temp
// directories of this file are all created under one root that is removed once, after the file,
// instead of a mkdtemp + recursive rm inside every timed test.
let scratchRoot: string;
let scratchCount = 0;

beforeAll(async () => {
  scratchRoot = mkdtempSync(join(tmpdir(), "identity-recovery-"));
  // One throwaway recovery pays the manager's one-time module/JIT cost outside the timed tests.
  const previous = process.env.AUTOMOBILE_DATA_DIR;
  process.env.AUTOMOBILE_DATA_DIR = scratchDir("identity-recovery-warm-");
  try {
    await harness({ accepted: true }).manager.status();
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMOBILE_DATA_DIR;
    } else {
      process.env.AUTOMOBILE_DATA_DIR = previous;
    }
  }
});

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

/** A fresh empty directory unique to the caller, removed with the file's scratch root. */
function scratchDir(prefix: string): string {
  const dir = join(scratchRoot, `${prefix}${scratchCount++}`);
  mkdirSync(dir);
  return dir;
}

beforeEach(() => {
  originalDataDir = process.env.AUTOMOBILE_DATA_DIR;
  isolatedDataDir = scratchDir("identity-recovery-data-");
  process.env.AUTOMOBILE_DATA_DIR = isolatedDataDir;
});

afterEach(() => {
  executionTracker.clearDaemonMaintenancePreparation();
  executionTracker.clearDaemonRestartPreparation();
  if (originalDataDir === undefined) {
    delete process.env.AUTOMOBILE_DATA_DIR;
  } else {
    process.env.AUTOMOBILE_DATA_DIR = originalDataDir;
  }
});

describe("provider-owned identity recovery", () => {
  test("Windows never probes socket identity with absent, present, stale, or malformed PID metadata", async () => {
    const dir = scratchDir("identity-win32-");
    const pidPath = join(dir, "daemon.pid");
    const controlPath = join(dir, "named-pipe");
    const manager = new DaemonManager({
      timer: new FakeTimer(),
      lockFilePath: join(dir, "lock"),
      pidFilePath: pidPath,
      socketPath: controlPath,
      processFinder: { findDaemonProcesses: () => [], isProcessRunning: (pid) => pid === 123 },
      platform: "win32",
    });
    const probe = spyOn(manager.testHooks.identityRecoveryIO, "probe").mockRejectedValue(
      new Error("connect ECONNREFUSED"),
    );
    expect(await manager.status()).toEqual({ running: false });
    writeFileSync(pidPath, JSON.stringify({ ...complete, socketPath: controlPath }));
    expect((await manager.status()).running).toBe(true);
    writeFileSync(pidPath, JSON.stringify({ ...complete, socketPath: controlPath, pid: 999 }));
    expect(await manager.status()).toEqual({ running: false });
    writeFileSync(pidPath, "malformed old metadata");
    expect(await manager.status()).toEqual({ running: false });
    expect(probe).not.toHaveBeenCalled();
  });

  for (const outcome of ["repaired", "deferred", "failed", "unauthenticated"] as const) {
    test(`fix 1: status ${outcome} records only status and republish RPCs`, async () => {
      const h = harness({ accepted: outcome !== "deferred" });
      const io = h.manager.testHooks.identityRecoveryIO;
      const original = io.probe;
      io.probe = async () => {
        await h.client.callDaemonMethod("ide/status", {});
        return original();
      };
      if (outcome === "failed") {
        h.setOwner({ ...complete, running: true, processGenerationToken: "other" });
      }
      if (outcome === "unauthenticated") {
        h.failProbe(new Error("malformed response"));
      }
      expect((await h.manager.status()).recovery?.state).toBe(outcome);
      expect(h.client.callDaemonMethodCalls.map((c) => c.method)).toEqual(
        outcome === "unauthenticated" ? ["ide/status"] : ["ide/status", REPUBLISH],
      );
    });
  }

  test("recovery lock follower waits for the successor's generation instead of joining the doomed incumbent", async () => {
    const dir = scratchDir("identity-follower-");
    const timer = new FakeTimer();
    const stopStarted = Promise.withResolvers<void>();
    const followerProbed = Promise.withResolvers<void>();
    const followerWaiting = Promise.withResolvers<void>();
    const launchStarted = Promise.withResolvers<void>();
    const publishSuccessor = Promise.withResolvers<void>();
    const sleep = timer.sleep.bind(timer);
    spyOn(timer, "sleep").mockImplementation((ms) => {
      if (ms === 100) {
        followerWaiting.resolve();
      }
      return sleep(ms);
    });
    const h = harness(
      { accepted: false, reason: "republish_unavailable" },
      join(dir, "lock"),
      timer,
    );
    const successor = { ...complete, pid: 124, startedAt: 200, processGenerationToken: "next" };
    const stop = spyOnPrivate(h.manager, "stopRunningDaemon").mockImplementation(async () => {
      stopStarted.resolve();
      await timer.sleep(300);
      h.setOwner({ running: false });
    });
    const launch = spyOn(h.manager.testHooks.launcher, "launchAndWait").mockImplementation(
      async () => {
        h.setOwner({ ...successor, running: true });
        // Listening is insufficient until the successor publishes its complete record.
        launchStarted.resolve();
        await publishSuccessor.promise;
        h.setRecord(successor);
      },
    );
    const peer = harness({ accepted: false }, join(dir, "lock"), timer);
    // Separate manager state, sharing only the filesystem lock and fake daemon endpoint.
    const recoveryIO = h.manager.testHooks.identityRecoveryIO;
    Object.assign(peer.manager, {
      identityRecoveryIO: {
        ...recoveryIO,
        probe: async () => {
          followerProbed.resolve();
          return recoveryIO.probe();
        },
      } satisfies IdentityRecoveryIO,
    });
    spyOnPrivate<[number], boolean>(peer.manager, "isProcessRunning").mockImplementation((pid) =>
      h.manager.testHooks.isProcessRunning(pid),
    );
    const reachable = spyOn(peer.manager, "waitForReady").mockResolvedValue(true);
    let joined: DaemonStatus | undefined;
    try {
      const first = h.manager.start();
      const follower = peer.manager.start().then(async (result) => {
        joined = await h.manager.status(false);
        return result;
      });
      await Promise.all([stopStarted.promise, followerProbed.promise, followerWaiting.promise]);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(joined).toBeUndefined();
      expect(h.record).toBeNull();
      await timer.resolvePromise(launchStarted.promise);
      expect(joined).toBeUndefined();
      expect(h.record).toBeNull();
      expect(reachable).not.toHaveBeenCalled();
      publishSuccessor.resolve();
      expect(await timer.resolvePromise(Promise.all([first, follower]))).toEqual([
        "replaced",
        "joined",
      ]);
      expect(joined).toMatchObject({
        running: true,
        pid: 124,
        startedAt: 200,
        processGenerationToken: "next",
      });
      expect(reachable).not.toHaveBeenCalled();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(h.client.callDaemonMethodCalls.filter((c) => c.method === ADMIT)).toHaveLength(1);
    } finally {
      publishSuccessor.resolve();
      h.manager.releaseLock();
    }
  });

  test("follower arriving during incumbent authentication waits for the replacement decision and successor", async () => {
    const dir = scratchDir("identity-auth-window-");
    const timer = new FakeTimer();
    const h = harness({ accepted: false }, join(dir, "lock"), timer);
    const peer = harness({ accepted: false }, join(dir, "lock"), timer);
    const io = h.manager.testHooks.identityRecoveryIO;
    Object.assign(peer.manager, { identityRecoveryIO: io });
    spyOnPrivate<[number], boolean>(peer.manager, "isProcessRunning").mockImplementation((pid) =>
      h.manager.testHooks.isProcessRunning(pid),
    );
    const probe = io.probe;
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let entered!: () => void;
    const authenticating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let followerProbed!: () => void;
    const followerWaiting = new Promise<void>((resolve) => {
      followerProbed = resolve;
    });
    let firstProbe = true;
    spyOn(io, "probe").mockImplementation(async () => {
      if (firstProbe) {
        firstProbe = false;
        entered();
        await gate;
      } else {
        followerProbed();
      }
      return probe();
    });
    const successor = { ...complete, pid: 124, startedAt: 200, processGenerationToken: "next" };
    const replacement = spyOn(h.manager, "restart").mockImplementation(async () => {
      h.setOwner({ ...successor, running: true });
      h.setRecord(successor);
      return "restarted";
    });
    const reachable = spyOn(peer.manager, "waitForReady").mockResolvedValue(true);
    let joined = false;
    try {
      const start = h.manager.start();
      await authenticating;
      expect(h.manager.testHooks.readStartupLockHolder().recovering).toBe(true);
      const follower = peer.manager.start().then((result) => {
        joined = true;
        return result;
      });
      await followerWaiting;
      expect(joined).toBe(false);
      expect(replacement).not.toHaveBeenCalled();
      expect(h.client.callDaemonMethodCalls).toHaveLength(0);
      unblock();
      expect(await timer.resolvePromise(Promise.all([start, follower]))).toEqual([
        "replaced",
        "joined",
      ]);
      expect(h.record?.processGenerationToken).toBe("next");
      expect(reachable).not.toHaveBeenCalled();
      expect(existsSync(join(dir, "lock"))).toBe(false);
    } finally {
      unblock();
      h.manager.releaseLock();
    }
  });

  // Requires real POSIX symlink and O_NOFOLLOW semantics, independent of platformOverride.
  test.skipIf(process.platform === "win32")(
    "symlinked startup lock leaves its target untouched and identity recovery completes",
    async () => {
      const dir = scratchDir("identity-symlink-marker-");
      const path = join(dir, "lock");
      const target = join(dir, "target");
      const h = harness({ accepted: true }, path);
      try {
        expect(h.manager.acquireLock()).toBe(true);
        const content = readFileSync(path, "utf8");
        writeFileSync(target, content, { mode: 0o600 });
        rmSync(path);
        symlinkSync(target, path);
        expect(() => h.manager.testHooks.markStartupLockRecovering()).not.toThrow();
        expect(readFileSync(target, "utf8")).toBe(content);
        const recovered = await h.manager.testHooks.recoverSocketIdentity();
        expect(recovered.running).toBe(true);
        expect(h.record).toEqual(complete);
        expect(readFileSync(target, "utf8")).toBe(content);
      } finally {
        h.manager.releaseLock();
      }
    },
  );

  // Windows does not implement POSIX group/other write permission bits.
  test.skipIf(process.platform === "win32")(
    "writable startup lock is unchanged and identity recovery completes",
    async () => {
      const dir = scratchDir("identity-unsafe-mode-marker-");
      const path = join(dir, "lock");
      const h = harness({ accepted: true }, path);
      try {
        expect(h.manager.acquireLock()).toBe(true);
        const content = readFileSync(path, "utf8");
        chmodSync(path, 0o666);
        expect(() => h.manager.testHooks.markStartupLockRecovering()).not.toThrow();
        expect(readFileSync(path, "utf8")).toBe(content);
        const recovered = await h.manager.testHooks.recoverSocketIdentity();
        expect(recovered.running).toBe(true);
        expect(h.record).toEqual(complete);
        expect(readFileSync(path, "utf8")).toBe(content);
      } finally {
        h.manager.releaseLock();
      }
    },
  );

  test("safe owned startup lock writes the recovery marker preserving PID, token, and generation", () => {
    const dir = scratchDir("identity-safe-marker-");
    const h = harness({ accepted: true }, join(dir, "lock"));
    try {
      expect(h.manager.acquireLock()).toBe(true);
      const path = join(dir, "lock");
      const { pid, token } = parseLockContent(readFileSync(path, "utf8").trim());
      const generation = "linux:boot:123";
      const oldBody = formatLockContent(
        pid,
        token,
        JSON.stringify({ logPath: "", extra: "x".repeat(200) }),
        generation,
      );
      writeFileSync(path, oldBody);
      const before = h.manager.testHooks.readStartupLockHolder();
      expect(before.recovering).toBe(false);
      h.manager.testHooks.markStartupLockRecovering();
      expect(h.manager.testHooks.readStartupLockHolder()).toEqual({ ...before, recovering: true });
      const body = readFileSync(path, "utf8");
      expect(body).toBe(
        formatLockContent(
          pid,
          token,
          JSON.stringify({ logPath: "", recovering: true }),
          generation,
        ).padEnd(Buffer.byteLength(oldBody)),
      );
      expect(parseLockContent(body.trim())).toEqual({
        pid,
        token,
        metadata: JSON.stringify({ logPath: "", recovering: true }),
        generation,
      });
    } finally {
      h.manager.releaseLock();
    }
  });

  test("a different holder's recovery marker invalidates ordinary readiness", async () => {
    const dir = scratchDir("identity-new-holder-");
    const h = harness({ accepted: false }, join(dir, "lock"));
    const next = harness({ accepted: false }, join(dir, "lock"), h.timer);
    h.timer.enableAutoAdvance();
    Object.assign(next.manager, { identityRecoveryIO: h.manager.testHooks.identityRecoveryIO });
    const ready = spyOn(h.manager, "waitForReady").mockImplementation(async () => {
      h.manager.releaseLock();
      expect(next.manager.acquireLock()).toBe(true);
      next.manager.testHooks.markStartupLockRecovering();
      h.timer.setTimeout(() => h.setRecord(complete), 300);
      return true;
    });
    try {
      expect(h.manager.acquireLock()).toBe(true);
      expect(await h.manager.start()).toBe("joined");
      expect(h.record).toEqual(complete);
      expect(ready).toHaveBeenCalledTimes(1);
    } finally {
      next.manager.releaseLock();
      h.manager.releaseLock();
    }
  });

  test("torn JSON recovery metadata is retried before readiness is trusted", async () => {
    const dir = scratchDir("identity-torn-marker-");
    const path = join(dir, "lock");
    const h = harness({ accepted: false }, path);
    h.timer.enableAutoAdvance();
    const ready = spyOn(h.manager, "waitForReady").mockResolvedValue(true);
    try {
      expect(h.manager.acquireLock()).toBe(true);
      h.manager.testHooks.markStartupLockRecovering();
      const content = readFileSync(path, "utf8");
      writeFileSync(path, content.slice(0, content.indexOf("{") + 1));
      h.timer.setTimeout(() => writeFileSync(path, content), 1);
      const holder = await h.manager.testHooks.readSettledStartupLockHolder(30000);
      expect(holder.recovering).toBe(true);
      expect(holder.metadataPending).toBeUndefined();
      expect(h.timer.now()).toBe(1);
      h.timer.setTimeout(() => h.setRecord(complete), 300);
      expect(await h.manager.start()).toBe("joined");
      expect(h.record).toEqual(complete);
      expect(ready).not.toHaveBeenCalled();
    } finally {
      h.manager.releaseLock();
    }
  });

  test("in-place repair releases its recovery marker before a later ordinary follower", async () => {
    const dir = scratchDir("identity-marker-release-");
    const h = harness({ accepted: true }, join(dir, "lock"));
    try {
      expect(await h.manager.start()).toBe("joined");
      expect(existsSync(join(dir, "lock"))).toBe(false);
      expect(h.manager.acquireLock()).toBe(true);
      expect(h.manager.testHooks.readStartupLockHolder().recovering).toBeUndefined();
      const ready = spyOn(h.manager, "waitForReady").mockResolvedValue(true);
      const probe = spyOn(h.manager.testHooks.identityRecoveryIO, "probe");
      expect(await h.manager.start()).toBe("joined");
      expect(ready).toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    } finally {
      h.manager.releaseLock();
    }
  });

  test("ordinary lock followers never inspect socket identity and retain the full budget", async () => {
    const dir = scratchDir("identity-ordinary-follower-");
    const h = harness({ accepted: false }, join(dir, "lock"));
    const io = h.manager.testHooks.identityRecoveryIO;
    const socketExists = spyOn(io, "socketExists");
    const probe = spyOn(io, "probe");
    const ready = spyOn(h.manager, "waitForReady").mockResolvedValue(true);
    try {
      expect(h.manager.acquireLock()).toBe(true);
      expect(await h.manager.start()).toBe("joined");
      expect(ready.mock.calls[0]?.[0]).toBe(DAEMON_STARTUP_TIMEOUT_MS);
      expect(socketExists).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    } finally {
      h.manager.releaseLock();
    }
  });

  test("a recovery marker published during readiness switches the follower to identity waiting", async () => {
    const dir = scratchDir("identity-transition-follower-");
    const h = harness({ accepted: false }, join(dir, "lock"));
    h.timer.enableAutoAdvance();
    const ready = spyOn(h.manager, "waitForReady").mockImplementation(async () => {
      h.manager.testHooks.markStartupLockRecovering();
      h.timer.setTimeout(() => h.setRecord(complete), 300);
      return true;
    });
    try {
      expect(h.manager.acquireLock()).toBe(true);
      expect(await h.manager.start()).toBe("joined");
      expect(ready).toHaveBeenCalledTimes(1);
      expect(h.record).toEqual(complete);
    } finally {
      h.manager.releaseLock();
    }
  });

  test.each(["repair", "timeout", "stalled probe"])(
    "recovery lock follower handles %s within the arbitration budget",
    async (outcome) => {
      const dir = scratchDir("identity-follower-budget-");
      const h = harness({ accepted: false }, join(dir, "lock"));
      h.timer.enableAutoAdvance();
      const reachable = spyOn(h.manager, "waitForReady").mockResolvedValue(true);
      try {
        expect(h.manager.acquireLock()).toBe(true);
        h.manager.testHooks.markStartupLockRecovering();
        if (outcome === "repair") {
          h.timer.setTimeout(() => h.setRecord(complete), 300);
        }
        if (outcome === "stalled probe") {
          const io = h.manager.testHooks.identityRecoveryIO;
          const probe = io.probe;
          let calls = 0;
          spyOn(io, "probe").mockImplementation(() =>
            calls++ === 0 ? probe() : new Promise<DaemonStatus>(() => {}),
          );
        }
        const follower = h.manager.start();
        if (outcome === "repair") {
          expect(await follower).toBe("joined");
          expect(await h.manager.status(false)).toMatchObject({
            pid: complete.pid,
            processGenerationToken: complete.processGenerationToken,
          });
        } else {
          await expect(follower).rejects.toThrow("failed to become ready");
          expect(h.timer.now()).toBe(DAEMON_STARTUP_TIMEOUT_MS);
        }
        expect(reachable).not.toHaveBeenCalled();
      } finally {
        h.manager.releaseLock();
      }
    },
  );

  test("fix 2: accepted but unverified publication fails status and blocks explicit start", async () => {
    const h = harness();
    h.setOwner({ ...complete, running: true, processGenerationToken: "different" });
    const restart = spyOn(h.manager, "restart");
    expect(await h.manager.status()).toMatchObject({
      running: false,
      recovery: { state: "failed" },
    });
    h.setRecord(null);
    await expect(h.manager.testHooks.startUnlocked({})).rejects.toThrow("Republish accepted");
    expect(restart).not.toHaveBeenCalled();
    expect(h.client.callDaemonMethodCalls.every((c) => c.method === REPUBLISH)).toBe(true);
  });

  for (const field of ["reportedPidFilePath", "reportedSocketPath"]) {
    test(`fix 2: foreign ${field} prevents publication and replacement`, async () => {
      const h = harness();
      h.setOwner({ ...complete, running: true, [field]: "/foreign" });
      expect(await h.manager.status()).toMatchObject({
        running: false,
        recovery: { state: "unauthenticated" },
      });
      await expect(h.manager.testHooks.startUnlocked({})).rejects.toThrow();
      expect(h.client.callDaemonMethodCalls).toHaveLength(0);
    });
  }

  test("fix 2: completeness follows the authenticated provider socket map", async () => {
    const h = harness();
    const providerSockets = { ...sockets, future: "/isolated/future.sock" };
    h.setOwner({ ...complete, running: true, reportedSockets: providerSockets });
    h.results.set(REPUBLISH, { accepted: true });
    spyOn(h.client, "callDaemonMethod").mockImplementation(async () => {
      h.setRecord({ ...complete, sockets: providerSockets });
      return { accepted: true };
    });
    expect((await h.manager.status()).recovery?.state).toBe("repaired");
  });

  for (const succeeds of [true, false]) {
    test(`fix 3: successor complete-record wait ${succeeds ? "succeeds" : "times out without claiming killed owner"}`, async () => {
      const h = harness({ accepted: false, reason: "republish_unavailable" });
      const evidence = await h.manager.status();
      const successor = { ...complete, pid: 124, startedAt: 200, processGenerationToken: "next" };
      spyOn(h.manager, "restart").mockImplementation(async () => {
        h.setOwner({ ...successor, running: true });
        if (succeeds) {
          h.timer.setTimeout(() => h.setRecord(successor), 300);
        }
        return "restarted";
      });
      const result = await h.manager.testHooks.replaceRecoveryOwner(replacementOwnerOf(evidence));
      expect(result).toMatchObject({
        running: succeeds,
        recovery: { state: succeeds ? "replaced" : "failed" },
      });
      expect(result.pid).not.toBe(123);
      expect(h.timer.now()).toBeGreaterThanOrEqual(succeeds ? 300 : 5000);
    });
  }

  test("fix 3: an already-started successor is reported as joined", async () => {
    const h = harness({ accepted: false });
    const evidence = await h.manager.status();
    spyOn(h.manager, "restart").mockImplementation(async () => {
      const successor = { ...complete, pid: 124, startedAt: 200 };
      h.setOwner({ ...successor, running: true });
      h.setRecord(successor);
      return "joined";
    });
    expect(
      (await h.manager.testHooks.replaceRecoveryOwner(replacementOwnerOf(evidence))).recovery
        ?.state,
    ).toBe("joined");
  });

  test("fix 4: explicit stop authenticates missing metadata without republishing", async () => {
    const h = harness();
    const stop = spyOnPrivate(h.manager, "stopRunningDaemon").mockResolvedValue(undefined);
    await h.manager.stop();
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ pid: 123 }), expect.any(Number));
    expect(h.client.callDaemonMethodCalls).toHaveLength(0);
  });

  // #11252: stop reported "Daemon is not running" and exited 0 while a foreign process held the socket.
  test("explicit stop refuses an unauthenticated socket owner instead of reporting not running", async () => {
    const h = harness();
    h.failProbe(new ActionableError("no version identity"));
    // The harness signaler throws "must not signal", so reaching the kill path fails differently.
    await expect(h.manager.stop()).rejects.toThrow(
      `Daemon socket ${socketPath} is held by a process that could not be authenticated as this namespace's daemon (unauthenticated: no version identity); nothing was stopped.`,
    );
    expect(h.client.callDaemonMethodCalls).toHaveLength(0);
  });

  test("explicit stop of a refused stale socket still reports not running", async () => {
    const h = harness();
    h.failProbe(new Error("connect ECONNREFUSED"));
    await h.manager.stop();
    expect(h.client.callDaemonMethodCalls).toHaveLength(0);
  });

  test("fix 5: refused stale socket is ordinary not-running without recovery presentation", async () => {
    const h = harness();
    h.failProbe(new Error("connect ECONNREFUSED"));
    expect(await h.manager.status()).toEqual({ running: false });
    expect(h.client.callDaemonMethodCalls).toHaveLength(0);
  });

  test("in-place republish restores complete authoritative PID metadata before success", async () => {
    const h = harness();
    const restart = spyOn(h.manager, "restart");
    expect(await h.manager.status()).toEqual({
      ...complete,
      running: true,
      recovery: { state: "repaired" },
    });
    expect(await h.manager.status()).toEqual({ ...complete, running: true });
    expect(h.client.callDaemonMethodCalls.map((c) => c.method)).toEqual([REPUBLISH]);
    expect(restart).not.toHaveBeenCalled();
  });

  test("fix 1: explicit start performs maintenance-admitted replacement preserving options and database", async () => {
    const h = harness({ accepted: false, reason: "republish_unavailable" });
    const startUnlocked = h.manager["startUnlocked"].bind(h.manager);
    const restart = spyOn(h.manager, "restart");
    // Only the process stop/start boundaries are fake; exercise the real restart admission.
    const stop = spyOnPrivate(h.manager, "stopRunningDaemon").mockResolvedValue(undefined);
    const start = spyOnPrivate<[DaemonOptions], Promise<string>>(
      h.manager,
      "startUnlocked",
    ).mockImplementation(async (options) => {
      expect(options).toEqual({ ...complete.options, strictPort: true });
      expect(h.manager.testHooks.daemonLaunchEnvironment(options).AUTOMOBILE_DB_PATH).toBe(
        complete.dbPath,
      );
      const replacement = {
        ...complete,
        pid: 124,
        startedAt: 200,
        processGenerationToken: "generation-2",
      };
      h.setOwner({ ...replacement, running: true });
      h.setRecord(replacement);
      return "started";
    });
    expect(await startUnlocked({})).toBe("replaced");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 123 }),
      expect.any(Number),
      false,
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(h.client.callDaemonMethodCalls.map((c) => c.method)).toContain(ADMIT);
    expect(h.client.callDaemonMethodCalls.map((c) => c.method)).not.toContain("ide/prepareRestart");
  });

  for (const reason of ["active_sessions", "active_operations"]) {
    test(`${reason} defer recovery without repair, replacement or signals`, async () => {
      const h = harness({ accepted: false, reason });
      const restart = spyOn(h.manager, "restart");
      expect((await h.manager.status()).recovery).toMatchObject({ state: "deferred", reason });
      expect(h.record).toBeNull();
      expect(restart).not.toHaveBeenCalled();
    });
    test(`${reason} defer fallback at maintenance admission without stopping`, async () => {
      const h = harness({ accepted: false, reason: "republish_unavailable" });
      h.results.set(PREPARE, { accepted: false, reason });
      const stop = spyOnPrivate(h.manager, "stopRunningDaemon");
      expect(
        (
          await h.manager.testHooks.replaceRecoveryOwner(
            replacementOwnerOf(await h.manager.status()),
          )
        ).recovery,
      ).toMatchObject({
        state: "deferred",
        reason: expect.stringContaining(reason),
      });
      expect(stop).not.toHaveBeenCalled();
      expect(h.client.callDaemonMethodCalls.some((c) => c.method === ADMIT)).toBe(false);
    });
  }

  test("concurrent status callers share exactly one in-place repair RPC", async () => {
    const h = harness();
    const results = await Promise.all(Array.from({ length: 8 }, () => h.manager.status()));
    expect(results.every((r) => r.recovery?.state === "repaired")).toBe(true);
    expect(h.client.callDaemonMethodCalls.filter((c) => c.method === REPUBLISH)).toHaveLength(1);
  });

  test("fix 1: concurrent status callers share republish refusal without maintenance or replacement", async () => {
    const h = harness({ accepted: false, reason: "republish_failed" });
    const restart = spyOn(h.manager, "restart");
    const results = await Promise.all(Array.from({ length: 8 }, () => h.manager.status()));
    expect(results.every((r) => r.recovery?.state === "deferred")).toBe(true);
    expect(h.client.callDaemonMethodCalls.map((c) => c.method)).toEqual([REPUBLISH]);
    expect(restart).not.toHaveBeenCalled();
  });

  test("malformed or unauthenticated socket status returns typed failure and attempts no recovery", async () => {
    for (const error of [
      new ActionableError("no version identity"),
      new ActionableError("malformed startup options"),
    ]) {
      const h = harness();
      h.failProbe(error);
      expect(await h.manager.status()).toEqual({
        running: false,
        recovery: { state: "unauthenticated", reason: error.message },
      });
      expect(h.client.callDaemonMethodCalls).toHaveLength(0);
    }
  });

  test("socket identity alone cannot authorize repair without complete generation fields", async () => {
    const h = harness();
    h.setOwner({ running: true, pid: 123, version: "1.0", socketPath });
    expect((await h.manager.status()).recovery?.state).toBe("unauthenticated");
    expect(h.client.callDaemonMethodCalls).toHaveLength(0);
  });

  test("dead PID metadata recovers the authenticated incumbent instead of unlinking socket", async () => {
    const h = harness();
    h.setRecord({ ...complete, pid: 999 });
    expect((await h.manager.status()).recovery?.state).toBe("repaired");
  });

  test("unavailable incumbent database path defers replacement instead of changing databases", async () => {
    const h = harness({ accepted: false, reason: "republish_unavailable" });
    h.setOwner({ ...complete, running: true, dbPath: undefined });
    expect((await h.manager.status()).recovery?.state).toBe("deferred");
    expect(h.client.callDaemonMethodCalls.map((c) => c.method)).toEqual([REPUBLISH]);
  });

  test("live partial early-owner record does not trigger recovery", async () => {
    const h = harness();
    // Real early-owner records carry the control socket even before bind/build
    // metadata is published. Keep the partial fixture attributable to this namespace.
    h.setRecord({ pid: 123, startedAt: 100, socketPath } as PidFileData);
    expect(await h.manager.status()).toEqual({
      pid: 123,
      startedAt: 100,
      socketPath,
      running: true,
    });
    expect(h.client.callDaemonMethodCalls).toHaveLength(0);
  });

  test("generation changes after republish acknowledgement cannot report success", async () => {
    const h = harness();
    h.setOwner({ ...complete, running: true, processGenerationToken: "other" });
    expect((await h.manager.status()).recovery?.state).toBe("failed");
  });
});

function provider(
  sessions: Session[] = [],
  token = "provider-generation",
  claimed: Record<string, unknown> = { processGenerationToken: token },
) {
  let writes = 0;
  const server = createTestUnixSocketServer(
    socketPath,
    {
      isInitialized: () => true,
      getSessionManager: () => ({
        hasSession: () => false,
        getDeviceLabels: () => undefined,
        getAllSessions: () => sessions,
        getSession: () => null,
        releaseSession: async () => null,
      }),
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
        releaseDevice: async () => {},
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    },
    new FakeTimer(),
    null,
    {
      identityStartedAt: 100,
      processGenerationToken: token,
      onRepublishIdentity: async () => {
        writes++;
        return true;
      },
    },
  );
  const params = {
    pid: process.pid,
    startedAt: 100,
    ...claimed,
    version: DAEMON_VERSION,
    ...getCurrentBuildIdentity(),
  };
  const request = (method: string, requestParams: Record<string, unknown> = {}) =>
    server["handleLocalSocketRequest"]({
      id: "request",
      type: "daemon_request",
      method,
      params: requestParams,
    });
  const call = (overrides = {}) => request(REPUBLISH, { ...params, ...overrides });
  return {
    call,
    request,
    get writes() {
      return writes;
    },
  };
}

describe("republish admin RPC admission", () => {
  test("provider coalesces concurrent cross-process requests into one publication", async () => {
    const p = provider();
    expect(await Promise.all([p.call(), p.call(), p.call()])).toEqual([
      { accepted: true },
      { accepted: true },
      { accepted: true },
    ]);
    expect(p.writes).toBe(1);
  });
  test("provider rejects a stale process generation even during a concurrent repair", async () => {
    const p = provider();
    const first = p.call();
    expect(await p.call({ processGenerationToken: "stale" })).toEqual({
      accepted: false,
      reason: "generation_changed",
    });
    await first;
    expect(p.writes).toBe(1);
  });
  test("a daemon with a zone-free Darwin token accepts a republish echoing the zone-free field", async () => {
    const utc = "darwin-utc:Tue Oct 6 07:35:51 2026";
    const p = provider([], utc, { processGenerationTokenUtc: utc });
    expect(await p.call()).toEqual({ accepted: true });
    expect(p.writes).toBe(1);
  });
  test("ide/status publishes a zone-free Darwin token only under the zone-free field", async () => {
    const utc = "darwin-utc:Tue Oct 6 07:35:51 2026";
    const status = await provider([], utc).request("ide/status");
    expect(status.processGenerationTokenUtc).toBe(utc);
    expect("processGenerationToken" in status).toBe(false);
  });
  test("ide/status keeps a Linux token under the legacy field", async () => {
    const linux = "linux:boot-id:424242";
    const status = await provider([], linux).request("ide/status");
    expect(status.processGenerationToken).toBe(linux);
    expect("processGenerationTokenUtc" in status).toBe(false);
  });
  test("a zone-free daemon rejects a republish echoing a different zone-free token", async () => {
    const utc = "darwin-utc:Tue Oct 6 07:35:51 2026";
    const p = provider([], utc, {
      processGenerationTokenUtc: "darwin-utc:Tue Oct 6 09:30:00 2026",
    });
    expect(await p.call()).toEqual({ accepted: false, reason: "generation_changed" });
    expect(p.writes).toBe(0);
  });
  test("a zone-free daemon rejects an older client's republish, which sees no token (safe deferral)", async () => {
    const utc = "darwin-utc:Tue Oct 6 07:35:51 2026";
    const p = provider([], utc, {});
    expect(await p.call()).toEqual({ accepted: false, reason: "generation_changed" });
    expect(p.writes).toBe(0);
  });
  test("fix 4: provider republishes with active sessions without maintenance admission", async () => {
    const p = provider([createFakeSession("active", "emulator-5554", "android")]);
    expect(await p.call()).toEqual({ accepted: true });
    expect(p.writes).toBe(1);
  });
  test("fix 4: republish does not contend with tool execution admission", async () => {
    const p = provider();
    const operation = executionTracker.startExecution("tapOn", "active-operation");
    try {
      const pending = p.call();
      const concurrent = executionTracker.startExecution("tapOn", "during-republish");
      executionTracker.endExecution(concurrent.id);
      expect(await pending).toEqual({ accepted: true });
      expect(p.writes).toBe(1);
    } finally {
      executionTracker.endExecution(operation.id);
    }
  });
});

describe("incumbent-owned atomic publisher", () => {
  test("rewrites a complete record when the observation stream becomes available", async () => {
    const { "observation-stream": omittedStream, ...degradedSockets } = sockets;
    let record: PidFileData = { ...complete, sockets: degradedSockets };
    let writes = 0;
    const io = {
      readRecord: () => record,
      isProcessRunning: () => true,
      writeRecord: async () => {
        writes++;
        record = { ...complete, sockets };
      },
    };

    expect(record.sockets).not.toHaveProperty("observation-stream");
    expect(await republishOwnedIdentity(true, complete, io, sockets)).toBe(true);
    expect(writes).toBe(1);
    expect(record.sockets?.["observation-stream"]).toBe(omittedStream);
    expect(await republishOwnedIdentity(true, complete, io, sockets)).toBe(true);
    expect(writes).toBe(1);
  });

  test("success waits for complete atomic publication and later cross-process callers do not rewrite", async () => {
    let record: PidFileData | null = null;
    let writes = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const io = {
      readRecord: () => record,
      isProcessRunning: () => false,
      writeRecord: async () => {
        writes++;
        await pending;
        record = complete;
      },
    };
    let acknowledged = false;
    const first = republishOwnedIdentity(true, complete, io, sockets).then((value) => {
      acknowledged = value;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(io.readRecord()).toBeNull();
    finish();
    await first;
    expect(acknowledged).toBe(true);
    expect(io.readRecord()).toEqual(complete);
    expect(await republishOwnedIdentity(true, complete, io, sockets)).toBe(true);
    expect(writes).toBe(1);
  });

  test("a complete record carrying the zone-free field is already the owner's identity", async () => {
    const utc = "darwin-utc:Tue Oct 6 07:35:51 2026";
    const zoneFree: PidFileData = {
      ...complete,
      processGenerationToken: undefined,
      processGenerationTokenUtc: utc,
    };
    let writes = 0;
    const io = {
      readRecord: () => zoneFree,
      isProcessRunning: () => false,
      writeRecord: async () => {
        writes++;
      },
    };
    expect(
      await republishOwnedIdentity(
        true,
        { pid: 123, startedAt: 100, processGenerationToken: utc },
        io,
        sockets,
      ),
    ).toBe(true);
    expect(writes).toBe(0);
  });

  test("the recovery owner schema keeps the zone-free field", () => {
    const utc = "darwin-utc:Tue Oct 6 07:35:51 2026";
    const parsed = recoveryOwnerSchema.parse({
      ...complete,
      processGenerationToken: undefined,
      processGenerationTokenUtc: utc,
      running: true,
      reportedPidFilePath: "/isolated/pid",
      reportedSocketPath: socketPath,
      reportedSockets: sockets,
    });
    expect(parsed.processGenerationTokenUtc).toBe(utc);
  });

  test("publisher defers startup and preserves another live contender's early record", async () => {
    let writes = 0;
    const io = {
      readRecord: () => ({ ...complete, pid: 999 }),
      isProcessRunning: () => true,
      writeRecord: async () => {
        writes++;
      },
    };
    expect(await republishOwnedIdentity(false, complete, io, sockets)).toBe(false);
    expect(await republishOwnedIdentity(true, complete, io, sockets)).toBe(false);
    expect(writes).toBe(0);
  });
});
