import { makePool } from "../helpers/makePool";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  DeviceOwnedByOtherDaemonError,
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
} from "../../src/models/deviceAcquisitionRefusals";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import type { DeviceSession } from "../../src/db/types";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceClaims } from "../fakes/FakeDeviceClaims";
import {
  lazyDeviceClaims,
  StoreDeviceClaimMirror,
  type DeviceClaim,
  type DeviceClaims,
} from "../../src/daemon/deviceClaims";
import {
  ForwardLeaseForeignDeviceOwnership,
  type DeviceOwnershipFileSource,
  type ForeignDeviceOwnership,
} from "../../src/daemon/foreignDeviceOwnership";
import type { LockContent } from "../../src/utils/fileLock";
import { logger } from "../../src/utils/logger";

// #11076: daemon A crashed holding emulator-5554 for session S; daemon B took the lapsed claim.
// When A restarts and S resumes, A must not rehydrate S onto the device B now drives.

const DEVICE_ID = "emulator-5554";
const AVD = "Original_AVD";
const SESSION = "restarted-session";
const DAEMON_A_PID = 1111;
const DAEMON_B_PID = 2222;

/** One host's claim files: device id -> owning daemon PID. */
class SharedClaimStore {
  readonly claims = new Map<string, number>();

  forDaemon(pid: number): ForeignDeviceOwnership {
    const store = this.claims;
    return {
      async refresh(): Promise<void> {},
      foreignOwnerPid(deviceId: string): number | undefined {
        const owner = store.get(deviceId);
        return owner === undefined || owner === pid ? undefined : owner;
      },
      async claim(deviceId: string): Promise<boolean> {
        const owner = store.get(deviceId);
        if (owner !== undefined && owner !== pid) {
          return false;
        }
        store.set(deviceId, pid);
        return true;
      },
      release(deviceId: string): void {
        if (store.get(deviceId) === pid) {
          store.delete(deviceId);
        }
      },
    };
  }
}

function persistedRow(): DeviceSession {
  return {
    session_uuid: SESSION,
    device_id: DEVICE_ID,
    stable_device_id: AVD,
    platform: "android",
    status: "expired",
    source: "session-manager",
    autolock_enabled: 0,
    mcp_session_id: null,
    daemon_session_id: "daemon-a-before-restart",
    created_at_ms: 1,
    last_used_at_ms: 20,
    activity_seq: 20,
    expires_at_ms: 30,
    released_at_ms: 25,
    release_reason: "daemon-restart",
    session_timeout_ms: 10,
    heartbeat_timeout_ms: 5,
    heartbeat_timeout_source: null,
    has_received_heartbeat: 1,
    liveness_policy: null,
    pre_cli_heartbeat_timeout_ms: null,
    pre_cli_heartbeat_timeout_source: null,
    pre_cli_session_timeout_ms: null,
    liveness_owner_token: null,
    liveness_contract_generation: 0,
    stable_identity_generation: 0,
    created_at: "2026-10-09T00:00:00.000Z",
    updated_at: "2026-10-09T00:00:00.000Z",
  };
}

describe("restart recovery onto a device another daemon holds (#11076)", () => {
  const managers: SessionManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) {
      manager.stopCleanupTimer();
    }
  });

  const restartedDaemonA = async (ownership: ForeignDeviceOwnership, initiallyEmpty = false) => {
    const timer = new FakeTimer();
    const persisted = persistedRow();
    const releaseReasons: string[] = [];
    const upserts: string[] = [];
    const persistence: DeviceSessionPersistence = Object.assign(
      new FakeDeviceSessionPersistence(),
      {
        recordLivenessOwnership: async () => {},
        replaceLivenessOwnership: async () => {},
        claimRecoverableSession: async (_id, expected) => expected.rowGeneration,
        async getSession() {
          return persisted;
        },
        async listRecoverableSessions() {
          return [persisted];
        },
        async upsertActiveSession(session) {
          upserts.push(session.sessionUuid);
        },
        async recordActivity() {},
        async markReleased(_sessionUuid, status, releasedAtMs, { reason: releaseReason }) {
          releaseReasons.push(releaseReason);
          persisted.status = status;
          persisted.released_at_ms = releasedAtMs;
          persisted.release_reason = releaseReason;
        },
      } satisfies Partial<DeviceSessionPersistence> & Record<string, unknown>,
    );
    const sessions = new SessionManager(timer, persistence);
    managers.push(sessions);
    const devices = new FakeDeviceManager();
    const device = { deviceId: DEVICE_ID, name: AVD, platform: "android" as const };
    devices.bootedDevices = [device];
    const pool = makePool(sessions, "daemon-a-after-restart", {
      timer,
      deviceManager: devices,
      foreignDeviceOwnership: ownership,
    });
    await pool.initializeWithDevices(initiallyEmpty ? [] : [device]);
    return { sessions, pool, persisted, releaseReasons, devices, upserts };
  };

  const resume = async (a: Awaited<ReturnType<typeof restartedDaemonA>>) =>
    await a.sessions
      .getOrCreateSession(SESSION, a.pool, "android", { requireIssuedSession: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

  test("a live foreign claim refuses recovery with device_owned_by_other_daemon and leaves it unassigned", async () => {
    const store = new SharedClaimStore();
    store.claims.set(DEVICE_ID, DAEMON_B_PID);
    const a = await restartedDaemonA(store.forDaemon(DAEMON_A_PID));

    const refusal = await resume(a);

    expect(refusal).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(refusal).toMatchObject({
      code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      deviceId: DEVICE_ID,
      ownerPid: DAEMON_B_PID,
    });
    expect(a.pool.getDevice(DEVICE_ID)?.sessionId ?? null).toBeNull();
    expect(a.sessions.getSession(SESSION)).toBeNull();
    expect(a.persisted.release_reason).toBe("identity-recovery-owned-by-other-daemon");
    expect(a.upserts).toEqual([]);
    expect(store.claims.get(DEVICE_ID)).toBe(DAEMON_B_PID);
  });

  test.each([false, true])(
    "startup rehydration leaves the live foreign owner's file and row untouched (empty pool: %s)",
    async (initiallyEmpty) => {
      const files = new Map<string, LockContent>();
      const foreignFile = { pid: DAEMON_B_PID, token: "b-token" };
      files.set(`/b/${DEVICE_ID}`, foreignFile);
      const source: DeviceOwnershipFileSource = {
        leasePath: () => undefined,
        claimPath: (id) => `/a/${id}`,
        legacyClaimPath: () => undefined,
        read: (path) => files.get(path),
        isProcessRunning: (pid) => pid === DAEMON_B_PID || pid === DAEMON_A_PID,
        tryAcquire: (path, owner) => {
          if (files.has(path)) {
            return false;
          }
          files.set(path, { pid: owner.pid, token: owner.ownerToken });
          return true;
        },
        takeOver: () => false,
        release: (path, owner) => {
          const held = files.get(path);
          if (held?.pid === owner.pid && held.token === owner.ownerToken) {
            files.delete(path);
          }
        },
      };
      const store = new FakeDeviceClaims();
      const foreignRow: DeviceClaim = {
        platform: "android",
        deviceId: DEVICE_ID,
        kind: "allocation",
        pid: DAEMON_B_PID,
        ownerToken: foreignFile.token,
        claimedAtMs: 1,
        updatedAtMs: 1,
      };
      await store.upsert(foreignRow);
      const upserted: DeviceClaim[] = [];
      const storeUpsert = store.upsert.bind(store);
      store.upsert = (claim) => {
        upserted.push(claim);
        return storeUpsert(claim);
      };
      const timer = new FakeTimer();
      const ownership = new ForwardLeaseForeignDeviceOwnership(
        DAEMON_A_PID,
        source,
        { query: async () => ({ kind: "unsupported", detail: "fake" }) },
        { ownerSocketPath: () => undefined, timer },
      );
      const mirror = new StoreDeviceClaimMirror({
        platform: "android",
        store: () => store,
        timer,
        generationOf: () => undefined,
      });
      ownership.attachClaimMirror(mirror);
      const a = await restartedDaemonA(ownership, initiallyEmpty);

      const refusals: unknown[] = [];
      const assign = a.pool.assignDeviceToSession.bind(a.pool);
      a.pool.assignDeviceToSession = (...args) =>
        assign(...args).then(undefined, (error: unknown) => {
          refusals.push(error);
          throw error;
        });
      const summary = await a.sessions.rehydratePersistedSessions(a.pool);
      await mirror.idle();

      expect(summary.rehydrated).toEqual([]);
      expect(refusals[0]).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
      expect(refusals[0]).toMatchObject({
        code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
        ownerPid: DAEMON_B_PID,
      });
      expect(summary.terminalized).toEqual([
        { sessionUuid: SESSION, reason: "identity-recovery-owned-by-other-daemon" },
      ]);
      expect(a.sessions.getSession(SESSION)).toBeNull();
      expect(a.upserts).toEqual([]);
      expect(upserted).toEqual([]);
      expect(await store.get("android", DEVICE_ID)).toEqual(foreignRow);
      expect([...files]).toEqual([[`/b/${DEVICE_ID}`, foreignFile]]);
      mirror.dispose();
    },
  );

  test("a foreign owner appearing during discovery is checked before recovery binds", async () => {
    const store = new SharedClaimStore();
    const a = await restartedDaemonA(store.forDaemon(DAEMON_A_PID), true);
    const discover = a.devices.getBootedDevicesDetailed.bind(a.devices);
    a.devices.getBootedDevicesDetailed = async (platform) => {
      store.claims.set(DEVICE_ID, DAEMON_B_PID);
      return discover(platform);
    };

    expect(await resume(a)).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(a.pool.getDevice(DEVICE_ID)?.sessionId).toBeNull();
    expect(a.sessions.getSession(SESSION)).toBeNull();
    expect(a.upserts).toEqual([]);
    expect(store.claims.get(DEVICE_ID)).toBe(DAEMON_B_PID);
  });

  test("a claim lost after assignment rolls the recovery back and terminalizes the session", async () => {
    const store = new SharedClaimStore();
    const own = store.forDaemon(DAEMON_A_PID);
    // Daemon B claims the device between the ownership refresh and daemon A's claim.
    const racing: ForeignDeviceOwnership = {
      refresh: (ids) => own.refresh(ids),
      foreignOwnerPid: (id) => own.foreignOwnerPid(id),
      claim: async (id) => {
        store.claims.set(id, DAEMON_B_PID);
        return await own.claim(id);
      },
      release: (id) => own.release(id),
    };
    const a = await restartedDaemonA(racing);

    const refusal = await resume(a);

    expect(refusal).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(refusal).toMatchObject({
      code: DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      ownerPid: DAEMON_B_PID,
    });
    expect(a.pool.getDevice(DEVICE_ID)?.sessionId ?? null).toBeNull();
    expect(a.sessions.getSession(SESSION)).toBeNull();
    expect(a.releaseReasons.at(-1)).toBe("identity-recovery-owned-by-other-daemon");
    expect(store.claims.get(DEVICE_ID)).toBe(DAEMON_B_PID);
  });

  test.each([undefined, DAEMON_A_PID])(
    "a free or locally owned recovery target is rebound and claimed (owner: %s)",
    async (owner) => {
      const store = new SharedClaimStore();
      if (owner !== undefined) {
        store.claims.set(DEVICE_ID, owner);
      }
      const a = await restartedDaemonA(store.forDaemon(DAEMON_A_PID));

      expect(await resume(a)).toBeUndefined();

      expect(a.pool.getDevice(DEVICE_ID)?.sessionId).toBe(SESSION);
      expect(store.claims.get(DEVICE_ID)).toBe(DAEMON_A_PID);
      a.pool.releaseDeviceClaimsForShutdown();
    },
  );
});

// #15738: separate claim roots make the host table the only evidence during startup recovery.
describe("startup rehydration respects foreign device claims", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) {
      dispose();
    }
  });

  async function startup(options: { file?: boolean; dead?: boolean; deferredOpen?: boolean } = {}) {
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    persistence.seed(persistedRow());
    const sessions = new SessionManager(timer, persistence);
    cleanup.push(() => sessions.stopCleanupTimer());
    const store = new FakeDeviceClaims();
    const foreign = {
      platform: "android" as const,
      deviceId: DEVICE_ID,
      kind: "allocation" as const,
      pid: DAEMON_B_PID,
      ownerToken: "b-token",
      processGenerationToken: "b-generation",
      metadata: JSON.stringify({ socketPath: "/fake/b.sock", acquiredAt: 0 }),
      claimedAtMs: 0,
      updatedAtMs: 0,
    };
    await store.upsert(foreign);
    const writes = mock(store.upsert.bind(store));
    store.upsert = writes;
    // Step (d): the table decides a claim through its atomic write, not the mirror's upsert.
    const claimWrites = mock(store.replaceIf.bind(store));
    store.replaceIf = claimWrites;
    const files = new Map<string, LockContent>();
    if (options.file) {
      files.set(DEVICE_ID, { pid: DAEMON_B_PID, token: "b-token", metadata: foreign.metadata });
    }
    const source: DeviceOwnershipFileSource = {
      leasePath: () => undefined,
      legacyClaimPath: () => undefined,
      claimPath: (id) => id,
      read: (path) => files.get(path),
      isProcessRunning: (pid) => pid === DAEMON_A_PID || (pid === DAEMON_B_PID && !options.dead),
      tryAcquire: (path, owner) => {
        if (files.has(path)) {
          return false;
        }
        files.set(path, { pid: owner.pid, token: owner.ownerToken, metadata: owner.metadata });
        return true;
      },
      takeOver: (path, observed, owner) => {
        const held = files.get(path);
        if (held?.pid !== observed.pid || held.token !== observed.token) {
          return false;
        }
        files.set(path, { pid: owner.pid, token: owner.ownerToken, metadata: owner.metadata });
        return true;
      },
      release: (path, owner) => {
        const held = files.get(path);
        if (held?.pid === owner.pid && held.token === owner.ownerToken) {
          files.delete(path);
        }
      },
    };
    const opening = Promise.withResolvers<{ deviceClaims(): DeviceClaims }>();
    if (!options.deferredOpen) {
      opening.resolve({ deviceClaims: () => store });
    }
    const readStarted = Promise.withResolvers<void>();
    const mirror = new StoreDeviceClaimMirror({
      platform: "android",
      timer,
      store: lazyDeviceClaims(() => opening.promise),
      whenOpen: async () => {
        readStarted.resolve();
        return (await opening.promise).deviceClaims();
      },
      generationOf: () => "a-generation",
      generationVerdict: () => "same",
    });
    cleanup.push(() => mirror.dispose());
    const claimed = mock(mirror.claimed.bind(mirror));
    mirror.claimed = claimed;
    const ownership = new ForwardLeaseForeignDeviceOwnership(
      DAEMON_A_PID,
      source,
      {
        query: async () => ({
          kind: "status",
          status: {
            pid: DAEMON_B_PID,
            deviceId: DEVICE_ID,
            sessionId: "b-session",
            activeExecutions: 0,
            idleForMs: null,
          },
        }),
      },
      { ownerSocketPath: () => undefined, timer },
    );
    ownership.attachClaimMirror(mirror);
    const devices = new FakeDeviceManager();
    const device = { deviceId: DEVICE_ID, name: AVD, platform: "android" as const };
    devices.bootedDevices = [device];
    const pool = makePool(sessions, "daemon-a-after-restart", {
      timer,
      deviceManager: devices,
      foreignDeviceOwnership: ownership,
      deviceClaimMirrors: { android: mirror },
    });
    cleanup.push(() => pool.releaseDeviceClaimsForShutdown());
    await pool.initializeWithDevices([device]);
    return {
      sessions,
      pool,
      persistence,
      store,
      mirror,
      foreign,
      files,
      writes,
      claimWrites,
      claimed,
      opening,
      readStarted,
      ownership,
    };
  }

  test.each([false, true])(
    "a live foreign owner terminalizes startup recovery (claim file=%s)",
    async (file) => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const a = await startup({ file });
        // The file case must prove the file alone decides too.
        if (file) {
          a.store.rows.clear();
        }

        const result = await a.sessions.rehydratePersistedSessions(a.pool);

        expect(result).toMatchObject({
          rehydrated: [],
          skipped: [],
          terminalized: [
            { sessionUuid: SESSION, reason: "identity-recovery-owned-by-other-daemon" },
          ],
        });
        expect(a.pool.getDevice(DEVICE_ID)?.sessionId ?? null).toBeNull();
        expect(a.sessions.getSession(SESSION)).toBeNull();
        expect(a.writes).not.toHaveBeenCalled();
        expect(a.claimed).not.toHaveBeenCalled();
        expect((await a.persistence.getSession(SESSION))?.release_reason).toBe(
          "identity-recovery-owned-by-other-daemon",
        );
        if (file) {
          expect(a.files.get(DEVICE_ID)).toMatchObject({ pid: DAEMON_B_PID, token: "b-token" });
        } else {
          expect(await a.store.get("android", DEVICE_ID)).toEqual(a.foreign);
          expect(a.files.size).toBe(0);
        }
        // The refusal reaches the log at warn and names the live owner.
        const warned = warn.mock.calls.map((args) => args.map(String).join(" "));
        expect(warned.some((line) => line.includes(`PID ${DAEMON_B_PID}`))).toBe(true);
      } finally {
        warn.mockRestore();
      }
    },
  );

  for (const file of [false, true]) {
    test(`a dead ${file ? "file" : "table"} owner permits startup recovery and exactly one claim write`, async () => {
      const a = await startup({ dead: true, file });
      const result = await a.sessions.rehydratePersistedSessions(a.pool);
      await a.mirror.idle();
      expect(result).toMatchObject({ rehydrated: [SESSION], terminalized: [], skipped: [] });
      expect(a.pool.getDevice(DEVICE_ID)?.sessionId).toBe(SESSION);
      expect(a.claimWrites).toHaveBeenCalledTimes(1);
      expect(a.writes).not.toHaveBeenCalled();
      expect(await a.store.get("android", DEVICE_ID)).toMatchObject({ pid: DAEMON_A_PID });
    });
  }

  test("startup recovery waits for the in-flight registry and sees the live table owner", async () => {
    const a = await startup({ deferredOpen: true });
    const recovery = a.sessions.rehydratePersistedSessions(a.pool);
    expect(
      await Promise.race([
        a.readStarted.promise.then(() => "waiting"),
        recovery.then(() => "finished"),
      ]),
    ).toBe("waiting");
    expect(a.writes).not.toHaveBeenCalled();
    a.opening.resolve({ deviceClaims: () => a.store });
    const result = await recovery;
    expect(result.terminalized).toEqual([
      { sessionUuid: SESSION, reason: "identity-recovery-owned-by-other-daemon" },
    ]);
    expect(a.pool.getDevice(DEVICE_ID)?.sessionId ?? null).toBeNull();
    expect(a.writes).not.toHaveBeenCalled();
    expect(a.claimed).not.toHaveBeenCalled();
    expect(await a.store.get("android", DEVICE_ID)).toEqual(a.foreign);
  });

  test("a table owner arriving after the first check is named in the rollback warning", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const a = await startup();
      a.store.rows.clear();
      const claim = a.ownership.claim.bind(a.ownership);
      a.ownership.claim = async (id) => {
        await a.store.upsert(a.foreign);
        return claim(id);
      };

      const result = await a.sessions.rehydratePersistedSessions(a.pool);

      expect(result.terminalized).toEqual([
        { sessionUuid: SESSION, reason: "identity-recovery-owned-by-other-daemon" },
      ]);
      expect(a.pool.getDevice(DEVICE_ID)?.sessionId ?? null).toBeNull();
      expect(await a.store.get("android", DEVICE_ID)).toEqual(a.foreign);
      expect(a.writes.mock.calls.map(([row]) => row.pid)).toEqual([DAEMON_B_PID]);
      expect(a.claimed).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`${DAEMON_B_PID}.*${DEVICE_ID}.*${SESSION}`)),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
