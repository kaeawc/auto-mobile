import { beforeEach, afterEach } from "bun:test";
import {
  SessionManager,
  type BiometricEnrollmentRestorer,
  type KeepScreenAwakeRestorer,
  type NetworkConditionRestorer,
  type SessionDeviceAssigner,
  type SessionManagerOptions,
} from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import type { BootedDevice } from "../../src/models";
import type {
  DeviceSessionPersistence,
  DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSession, DeviceSessionStatus } from "../../src/db/types";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Shared arrange helpers for the `test/daemon/sessionManager.<behaviour>.test.ts` suites: row and
 * manager builders, deferred persistence doubles, and the per-test manager fixture. The suites are
 * split by behaviour so each stays small; the setup they share lives here, once.
 */

export class DeferredDeviceSessionPersistence extends FakeDeviceSessionPersistence {
  async recordLivenessOwnership(): Promise<void> {}

  async replaceLivenessOwnership(): Promise<void> {}

  private deferredWrite: Promise<void> | null = null;
  private resolveDeferredWrite: (() => void) | null = null;
  private readonly writeStarted = Promise.withResolvers<void>();
  readonly upsertedDeviceIds: string[] = [];

  deferNextUpsert(): void {
    this.deferredWrite = new Promise<void>((resolve) => {
      this.resolveDeferredWrite = resolve;
    });
  }

  async waitForUpsert(): Promise<void> {
    await this.writeStarted.promise;
  }

  finishUpsert(): void {
    this.resolveDeferredWrite?.();
  }

  async upsertActiveSession(record: DeviceSessionRecord): Promise<number> {
    this.upsertedDeviceIds.push(record.deviceId);
    const deferredWrite = this.deferredWrite;
    if (!deferredWrite) {
      return 0;
    }
    this.deferredWrite = null;
    this.writeStarted.resolve();
    await deferredWrite;
    return 0;
  }

  async recordActivity(): Promise<void> {}

  async markReleased(): Promise<void> {}
}

export class DeferredLivenessRebindPersistence extends FakeDeviceSessionPersistence {
  readonly upsertStarted = Promise.withResolvers<void>();
  readonly finishUpsert = Promise.withResolvers<void>();
  persistedOwnerToken: string | null = null;
  deferUpsert = false;

  async upsertActiveSession(): Promise<number> {
    if (!this.deferUpsert) {
      return 0;
    }
    this.deferUpsert = false;
    this.upsertStarted.resolve();
    await this.finishUpsert.promise;
    return 0;
  }

  async recordActivity(): Promise<void> {}

  async recordLivenessOwnership(_sessionUuid: string, ownerToken: string | null): Promise<void> {
    this.persistedOwnerToken = ownerToken;
  }

  async replaceLivenessOwnership(_sessionUuid: string, ownerToken: string | null): Promise<void> {
    this.persistedOwnerToken = ownerToken;
  }

  async markReleased(): Promise<void> {}
}

export class DeferredReleaseDeviceSessionPersistence extends FakeDeviceSessionPersistence {
  readonly reasons: string[] = [];
  readonly releaseStarted = Promise.withResolvers<void>();
  readonly finishRelease = Promise.withResolvers<void>();

  override async markReleased(
    _sessionUuid: string,
    _status: DeviceSessionStatus,
    _releasedAtMs: number,
    { reason }: { reason: string },
  ): Promise<void> {
    this.reasons.push(reason);
    if (this.reasons.length === 1) {
      this.releaseStarted.resolve();
      await this.finishRelease.promise;
    }
  }
}

export function makeHierarchy(label: string): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        $: { "resource-id": `com.example:id/${label}` },
        "view-id": `com.example:id/${label}`,
      },
    },
  };
}

const HEARTBEAT_ENV_KEYS = [
  "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
] as const;

export function clearHeartbeatEnv(): void {
  for (const key of HEARTBEAT_ENV_KEYS) {
    delete process.env[key];
  }
}

/**
 * A persisted `device_sessions` row as a previous daemon left it (an expired Android session with
 * short timeouts). Override only the fields a test is about.
 */
export function sessionRow(overrides: Partial<DeviceSession> = {}): DeviceSession {
  return {
    session_uuid: "restarted-session",
    device_id: "emulator-5554",
    platform: "android",
    status: "expired",
    source: null,
    autolock_enabled: 0,
    mcp_session_id: null,
    daemon_session_id: "old-daemon",
    created_at_ms: 1,
    last_used_at_ms: 20,
    activity_seq: 0,
    stable_device_id: null,
    stable_identity_generation: 0,
    liveness_contract_generation: 0,
    heartbeat_timeout_source: null,
    liveness_policy: null,
    pre_cli_heartbeat_timeout_ms: null,
    pre_cli_heartbeat_timeout_source: null,
    pre_cli_session_timeout_ms: null,
    liveness_owner_token: null,
    expires_at_ms: 30,
    released_at_ms: 25,
    release_reason: "daemon-restart",
    session_timeout_ms: 10,
    heartbeat_timeout_ms: 5,
    has_received_heartbeat: 1,
    created_at: "2026-09-15T00:00:00.000Z",
    updated_at: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

/** A row with production-sized timeouts, as restart-recovery suites seed it. */
export function persistedRecoverySession(overrides: Partial<DeviceSession> = {}): DeviceSession {
  return sessionRow({
    session_uuid: "persisted-session",
    created_at_ms: 0,
    last_used_at_ms: 0,
    expires_at_ms: 1_000,
    released_at_ms: 0,
    session_timeout_ms: 60_000,
    heartbeat_timeout_ms: 10_000,
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-18T00:00:00.000Z",
    ...overrides,
  });
}

/** Persistence methods to replace; extra keys are tolerated (the repository has more writers than the seam). */
export type PersistenceOverrides = Partial<DeviceSessionPersistence> & Record<string, unknown>;

/**
 * Persistence whose liveness-ownership writes succeed without effect and whose recoverable-claim
 * returns the expected generation, over the in-memory fake; pass `overrides` for the writes a test
 * observes or fails.
 */
export function stubbedPersistence(overrides: PersistenceOverrides = {}): DeviceSessionPersistence {
  const base: Partial<DeviceSessionPersistence> = {
    recordLivenessOwnership: async () => {},
    replaceLivenessOwnership: async () => {},
    claimRecoverableSession: async (_id, expected) => expected.rowGeneration,
  };
  return Object.assign(new FakeDeviceSessionPersistence(), base, overrides);
}

/** Stubbed persistence whose every row write and the stale-session sweep are no-ops. */
export function quietPersistence(overrides: PersistenceOverrides = {}): DeviceSessionPersistence {
  return stubbedPersistence({
    async upsertActiveSession() {},
    async recordActivity() {},
    async markReleased() {},
    async markStaleActiveSessionsExpired() {},
    ...overrides,
  });
}

/**
 * Stubbed persistence that serves `row` from `getSession` and accepts every write; pass
 * `overrides` to observe or fail the writes a test is about.
 */
export function persistenceServing(
  row: DeviceSession,
  overrides: PersistenceOverrides = {},
): DeviceSessionPersistence {
  return stubbedPersistence({
    async getSession() {
      return row;
    },
    async upsertActiveSession() {},
    async recordActivity() {},
    async markReleased() {},
    ...overrides,
  });
}

export interface SessionManagerFixtureOptions extends SessionManagerOptions {
  timer?: FakeTimer;
  persistence?: DeviceSessionPersistence;
  /** Gives the manager a fresh `FakeDbWriteBarrier` per write instead of the shared barrier. */
  fakeBarrier?: boolean;
}

/** A `SessionManager` over fakes; omitted collaborators default to a fresh `FakeTimer`/persistence. */
export function makeSessionManager(options: SessionManagerFixtureOptions = {}): SessionManager {
  const { timer, persistence, fakeBarrier, ...managerOptions } = options;
  const manager = new SessionManager(
    timer ?? new FakeTimer(),
    persistence ?? new FakeDeviceSessionPersistence(),
    fakeBarrier ? { ...managerOptions, barrier: () => new FakeDbWriteBarrier() } : managerOptions,
  );
  liveManagers.add(manager);
  return manager;
}

/** Every manager built by {@link makeSessionManager} since the last teardown. */
const liveManagers = new Set<SessionManager>();

/** Stops the cleanup timer of every manager the test built; call from `afterEach`. */
export function stopBuiltSessionManagers(): void {
  for (const manager of liveManagers) {
    manager.stopCleanupTimer();
  }
  liveManagers.clear();
}

/** Registers the teardown for suites that build managers without {@link installSessionManagerFixture}. */
export function installSessionManagerCleanup(): void {
  afterEach(stopBuiltSessionManagers);
}

/** Keep-awake restorer whose restore always succeeds. */
export const restoredKeepAwake = (): KeepScreenAwakeRestorer => ({
  restore: async () => ({ status: "restored" as const }),
});

/** Biometric restorer that accepts every restore. */
export const noopBiometric = (): BiometricEnrollmentRestorer => ({ restore: async () => {} });

/**
 * A manager whose device-state restorers all succeed (keep-awake, biometric) over a fresh barrier
 * per write; pass the restorer a test observes in `options`, e.g. `restorers` or
 * `biometricEnrollmentRestorer`.
 */
export function makeRestoringManager(options: SessionManagerFixtureOptions = {}): SessionManager {
  return makeSessionManager({
    fakeBarrier: true,
    keepScreenAwakeRestorer: restoredKeepAwake,
    biometricEnrollmentRestorer: noopBiometric,
    ...options,
  });
}

/** Network-condition restorers that run `restore` for every restore, whichever device it is on. */
export function networkRestorer(restore: NetworkConditionRestorer["restore"]): {
  networkCondition: () => NetworkConditionRestorer;
} {
  return { networkCondition: () => ({ restore }) };
}

/** Network-condition restorers that record `{ deviceId, profile }` for every restore. */
export function recordingNetworkRestorers(restored: Array<{ deviceId: string; profile: string }>): {
  networkCondition: (device: BootedDevice) => NetworkConditionRestorer;
} {
  return {
    networkCondition: (device) => ({
      restore: async (profile) => {
        restored.push({ deviceId: device.deviceId, profile });
      },
    }),
  };
}

/** Biometric restorers that record `{ deviceId, enrollment }` for every restore. */
export function recordingBiometricRestorer(
  restored: Array<{ deviceId: string; enrollment: string }>,
): (device: BootedDevice) => BiometricEnrollmentRestorer {
  return (device) => ({
    restore: async (enrollment) => {
      restored.push({ deviceId: device.deviceId, enrollment });
    },
  });
}

/**
 * Registers the shared per-test fixture of the `SessionManager` suites: a fresh manager over a
 * `FakeTimer` and in-memory persistence, with the heartbeat env cleared around each test and the
 * manager's cleanup timer stopped afterwards. `assign` hands each test's instances to the suite.
 * Every manager a test builds with `makeSessionManager` is stopped afterwards too, so tests need
 * no `try/finally`.
 */
export function installSessionManagerFixture(
  assign: (fixture: { manager: SessionManager; timer: FakeTimer }) => void,
): void {
  beforeEach(() => {
    clearHeartbeatEnv();
    const timer = new FakeTimer();
    assign({ manager: makeSessionManager({ timer }), timer });
  });
  afterEach(() => {
    stopBuiltSessionManagers();
    clearHeartbeatEnv();
  });
}

/** The `device_sessions` write of a Pixel session as a daemon that is about to restart left it. */
export function restartRow(
  sessionUuid: string,
  overrides: Partial<DeviceSessionRecord> = {},
): DeviceSessionRecord {
  return {
    sessionUuid,
    deviceId: "emulator-5554",
    stableDeviceId: "Pixel_8_API_35",
    platform: "android",
    createdAtMs: 1,
    lastUsedAtMs: 20,
    expiresAtMs: 60_020,
    sessionTimeoutMs: 60_000,
    heartbeatTimeoutMs: 15_000,
    hasReceivedHeartbeat: true,
    ...overrides,
  };
}

/** Persists a session row and releases it for `daemon-restart`, awaiting recovery by the next daemon. */
export async function seedRestartReleasedRow(
  persistence: DeviceSessionPersistence,
  sessionUuid: string,
  overrides: Partial<DeviceSessionRecord> = {},
): Promise<void> {
  await persistence.upsertActiveSession(restartRow(sessionUuid, overrides));
  await persistence.markReleased(sessionUuid, "released", 30, { reason: "daemon-restart" });
}

/** Seeds one restart-released row per `[sessionUuid, lastUsedAtMs]`. */
export async function seedRestartReleasedRows(
  persistence: DeviceSessionPersistence,
  rows: Array<[sessionUuid: string, lastUsedAtMs: number]>,
): Promise<void> {
  for (const [sessionUuid, lastUsedAtMs] of rows) {
    await seedRestartReleasedRow(persistence, sessionUuid, { lastUsedAtMs });
  }
}

/**
 * A device pool that recovers each row by re-creating its session on `restarted`, carrying the
 * recovery target's liveness windows and stable identity; `before` runs ahead of each assignment.
 */
export function recoveringAssigner(
  restarted: SessionManager,
  options: { deviceId?: string; before?: (sessionId: string) => void | Promise<void> } = {},
): SessionDeviceAssigner {
  return {
    async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
      if (options.before) {
        await options.before(sessionId);
      }
      const session = await restarted.createSession(
        sessionId,
        options.deviceId ?? "emulator-5554",
        "android",
        {
          timeoutMs: target?.liveness?.sessionTimeoutMs,
          heartbeatTimeoutMs: target?.liveness?.heartbeatTimeoutMs,
          stableDeviceId: target?.stableDeviceId,
          recoveredLiveness: target?.liveness,
          initialOwnership: target?.initialOwnership,
        },
      );
      return session.assignedDevice;
    },
  };
}

/** Persistence serving `row` whose releases are written back onto it, as the database would. */
export function persistenceMirroringRelease(
  row: DeviceSession,
  releases?: string[],
): DeviceSessionPersistence {
  return persistenceServing(row, {
    async markReleased(_sessionUuid, status, releasedAtMs, { reason: releaseReason }) {
      releases?.push(releaseReason);
      row.status = status;
      row.released_at_ms = releasedAtMs;
      row.release_reason = releaseReason;
    },
  });
}

/** Recovers the persisted row's session through `devicePool`, as a socket admission does. */
export function recoverPersisted(
  manager: SessionManager,
  row: DeviceSession,
  devicePool: SessionDeviceAssigner,
): ReturnType<SessionManager["getOrCreateSession"]> {
  return manager.getOrCreateSession(row.session_uuid, devicePool, "android", {
    requireIssuedSession: true,
  });
}

/** A device pool that hands out `deviceId` and counts its assignments. */
export function countingAssigner(deviceId: string): SessionDeviceAssigner & {
  readonly assignments: number;
} {
  const pool = {
    assignments: 0,
    async assignDeviceToSession(): Promise<string> {
      pool.assignments++;
      return deviceId;
    },
  };
  return pool;
}

/** A device pool that re-creates each requested session on `manager`, recording the session ids. */
export function replacingAssigner(
  manager: SessionManager,
  deviceId = "device-2",
): SessionDeviceAssigner & { readonly assignedSessionIds: string[] } {
  const pool = {
    assignedSessionIds: [] as string[],
    async assignDeviceToSession(sessionId: string): Promise<string> {
      pool.assignedSessionIds.push(sessionId);
      const replacement = await manager.createSession(sessionId, deviceId, "android");
      return replacement.assignedDevice;
    },
  };
  return pool;
}

/**
 * A keep-awake restorer that parks inside `restore` until `finish()`; `started` settles once the
 * restore has begun, so a test can observe the session mid-teardown.
 */
export function gatedKeepAwakeRestore(): {
  restorer: () => KeepScreenAwakeRestorer;
  started: Promise<void>;
  finish: () => void;
} {
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  return {
    restorer: () => ({
      restore: async () => {
        started.resolve();
        await finished.promise;
        return { status: "restored" as const };
      },
    }),
    started: started.promise,
    finish: () => finished.resolve(),
  };
}

/** A session created as a recovered, still-unclaimed owner: 60 s idle window, 1 s heartbeat window. */
export function createAwaitingOwnerSession(
  manager: SessionManager,
  sessionId: string,
  deviceId = "emulator-5554",
): ReturnType<SessionManager["createSession"]> {
  return manager.createSession(sessionId, deviceId, "android", {
    timeoutMs: 60_000,
    heartbeatTimeoutMs: 1_000,
    initialOwnership: "awaiting-owner",
  });
}

/** A heartbeat monitor over `manager` that records the reason of every session it reaps. */
export function makeReapingMonitor(
  manager: SessionManager,
  timer: FakeTimer,
  preFirstHeartbeatGraceMs: number,
): { monitor: SessionHeartbeatMonitor; reaped: string[] } {
  const reaped: string[] = [];
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async (_id, reason) => {
      reaped.push(reason);
    },
    timer,
    { preFirstHeartbeatGraceMs },
  );
  return { monitor, reaped };
}
