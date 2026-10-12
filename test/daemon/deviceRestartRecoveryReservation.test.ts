import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import type { ManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import type { TerminalReleaseIntent } from "../../src/daemon/terminalReleaseJournal";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";
import {
  DEVICE_RESTART_RECOVERY_WINDOW_MS,
  SessionManager,
  TerminalSessionError,
  type RehydrationDeviceReservation,
} from "../../src/daemon/sessionManager";
import {
  AndroidBootAdmissionGate,
  ANDROID_MAX_BOOTED_ENV,
} from "../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { ActionableError, type BootedDevice } from "../../src/models";
import { fixedBackoff } from "../../src/utils/Backoff";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeAndroidCapacitySource } from "../fakes/FakeAndroidCapacitySource";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, drainUntil, settleByFakeEvents } from "../helpers/fakeTimerStepping";

const SIM: BootedDevice = { deviceId: "restart-sim", name: "restart-sim", platform: "ios" };
const SPARE: BootedDevice = { deviceId: "spare-sim", name: "spare-sim", platform: "ios" };
const HOLDER = "restart-holder";
const DAEMON_A = "restart-daemon-a";
const DAEMON_B = "restart-daemon-b";
interface ReservationInternals {
  releaseDisconnectedRecoverySessionWithRetry(
    sessionId: string,
    deviceId: string,
    reason: SessionReleaseReason,
    attempt?: () => Promise<void>,
  ): Promise<void>;
  notifyRehydrationReservationChanged(target: RehydrationDeviceReservation["target"]): void;
  rehydrationReservations: Map<
    string,
    RehydrationDeviceReservation["target"] & {
      restartHandoff?: boolean;
      daemonRehydration?: boolean;
      expiryTimer?: ReturnType<FakeTimer["setTimeout"]>;
      releasePersistence?: Promise<void>;
    }
  >;
}

describe("device restart reserves the entire recovery window", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let persistence: FakeDeviceSessionPersistence;
  let manager: FakeDeviceManager;
  let pool: DevicePool;
  let internals: ReservationInternals;
  let notifications: number;
  let managed: boolean;
  let refreshFails: boolean;
  let fixtureInitialized: boolean;
  let keepAwakeGate: PromiseWithResolvers<void>;
  let keepAwakeStarted: boolean;
  const slots: ManagedSlotExclusion = {
    refresh: async () => {
      if (refreshFails) {
        throw new Error("slot snapshot unavailable");
      }
    },
    holderOf: ({ stableIds }) =>
      managed && stableIds.includes(SIM.deviceId)
        ? {
            platform: "ios",
            stableDeviceId: SIM.deviceId,
            holder: "slot",
            scopeKey: "scope",
            slotIndex: 0,
            scopeState: null,
            execSessionUuid: "slot-exec",
          }
        : undefined,
    stableIdsFor: () => new Set(managed ? [SIM.deviceId] : []),
  };
  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    persistence = new FakeDeviceSessionPersistence();
    keepAwakeGate = Promise.withResolvers<void>();
    keepAwakeStarted = false;
    sessions = new SessionManager(
      timer,
      persistence,
      () => new FakeDbWriteBarrier(),
      () => ({
        restore: () => {
          keepAwakeStarted = true;
          return keepAwakeGate.promise;
        },
      }),
    );
    sessions.attachDaemonSessionId(DAEMON_A);
    sessions.stopCleanupTimer();
    manager = new FakeDeviceManager();
    managed = false;
    refreshFails = false;
    notifications = 0;
    fixtureInitialized = false;
    await setup();
  });
  afterEach(() => {
    pool?.releaseDeviceClaimsForShutdown();
    sessions.stopCleanupTimer();
    timer.reset();
  });
  async function setup(devices: BootedDevice[] = [SIM], withSlots = false) {
    if (fixtureInitialized) {
      if (!withSlots && devices.length === 1 && devices[0] === SIM) {
        return;
      }
      pool.releaseDeviceClaimsForShutdown();
      sessions.stopCleanupTimer();
      persistence = new FakeDeviceSessionPersistence();
      sessions = new SessionManager(
        timer,
        persistence,
        () => new FakeDbWriteBarrier(),
        () => ({
          restore: () => {
            keepAwakeStarted = true;
            return keepAwakeGate.promise;
          },
        }),
      );
      sessions.attachDaemonSessionId(DAEMON_A);
      sessions.stopCleanupTimer();
      manager = new FakeDeviceManager();
    }
    manager.bootedDevices = devices;
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "restart-reservation", {
        timer,
        deviceManager: manager,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        retryExecutor: new DefaultRetryExecutor(timer),
        recoveryPolicy: { onLoss: false, maxAttempts: 1 },
        ...(withSlots ? { managedSlotExclusion: slots } : {}),
      }),
    );
    internals = pool as unknown as ReservationInternals;
    const notify = internals.notifyRehydrationReservationChanged.bind(pool);
    internals.notifyRehydrationReservationChanged = (target) => {
      notifications++;
      notify(target);
    };
    await pool.initializeWithDevices(devices);
    await pool.bindOrReuseDeviceSession(
      HOLDER,
      devices[0].deviceId,
      devices[0].platform,
      undefined,
      undefined,
      devices[0],
    );
    fixtureInitialized = true;
  }
  async function keepIdlePastRecovery() {
    const session = sessions.getSession(HOLDER)!;
    session.expiresAt = timer.now() + 600_000;
    const row = (await persistence.getSession(HOLDER))!;
    row.expires_at_ms = session.expiresAt;
    row.session_timeout_ms = 600_000;
  }
  async function advance(ms: number) {
    timer.advanceTime(ms);
    await drainMicrotasks(40);
  }
  async function handoff(device: BootedDevice = SIM) {
    await internals.releaseDisconnectedRecoverySessionWithRetry(
      HOLDER,
      device.deviceId,
      `device-restart:${device.name}`,
    );
    await pool.releaseDevice(device.deviceId, HOLDER);
    notifications = 0;
  }
  const newcomer = () =>
    sessions.getOrCreateSession("newcomer", pool, "ios").then(
      (session) => session,
      (error: unknown) => error,
    );
  async function absent() {
    manager.bootedDevices = [];
    await pool.removeDevice(SIM.deviceId, true, pool.getDevice(SIM.deviceId));
  }
  async function returned() {
    manager.bootedDevices = [SIM];
    await pool.initializeWithDevices([SIM]);
  }

  test("no waiting call: absent selector is refused and returning device stays reserved", async () => {
    await setup();
    await handoff();
    await absent();
    const result = await settleByFakeEvents(timer, newcomer(), { description: "absent selector" });
    expect(result).toBeInstanceOf(ActionableError);
    expect(sessions.hasSession(HOLDER)).toBe(false);
    await returned();
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    expect(pool.getDevice(SIM.deviceId)?.sessionId).toBeNull();
  });
  test("a selector takes the second idle match", async () => {
    await setup([SIM, SPARE]);
    await handoff();
    expect(await newcomer()).toMatchObject({ assignedDevice: SPARE.deviceId });
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
  });
  test("a selector with no other match gets the existing typed timeout", async () => {
    await setup();
    await handoff();
    const result = await settleByFakeEvents(timer, newcomer(), {
      description: "reserved selector",
    });
    expect(result).toBeInstanceOf(ActionableError);
    expect((result as Error).message).toContain("Timed out waiting for device");
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
  });
  test("binding by id refuses another session; reads remain open", async () => {
    await setup();
    await handoff();
    await expect(
      pool.bindOrReuseDeviceSession("newcomer", SIM.deviceId, "ios", undefined, undefined, SIM),
    ).rejects.toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
    expect(pool.getDevice(SIM.deviceId)?.id).toBe(SIM.deviceId);
    expect(pool.getDevicesByPlatform("ios")).toHaveLength(1);
  });
  test("managed slots win at reserve time and afterwards", async () => {
    await setup([SIM], true);
    managed = true;
    await handoff();
    expect(internals.rehydrationReservations.size).toBe(0);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("managed_slot");
    managed = false;
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    await sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true);
    await handoff();
    managed = true;
    await expect(
      pool.bindOrReuseDeviceSession("slot-exec", SIM.deviceId, "ios", undefined, undefined, SIM),
    ).resolves.toBe("slot-exec");
  });
  test("slot refresh failure reserves nothing", async () => {
    await setup([SIM], true);
    refreshFails = true;
    await handoff();
    expect(internals.rehydrationReservations.size).toBe(0);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
  });
  test("resuming ends the hold once and cancels expiry", async () => {
    await setup();
    await handoff();
    await sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true);
    expect(pool.getDevice(SIM.deviceId)?.sessionId).toBe(HOLDER);
    expect(notifications).toBe(1);
    pool.releaseRehydrationReservation(HOLDER);
    timer.advanceTime(DEVICE_RESTART_RECOVERY_WINDOW_MS);
    expect(notifications).toBe(1);
    await sessions.releaseSession(HOLDER, "explicit-release");
    await pool.releaseDevice(SIM.deviceId, HOLDER);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
  });
  for (const reason of [
    "explicit-release",
    "heartbeat-timeout",
    "cleanup-expired",
    "identity-recovery-target-busy",
  ] as const) {
    test(`${reason} terminal upgrade ends the hold once`, async () => {
      await setup();
      await handoff();
      await sessions.releaseSession(HOLDER, reason);
      expect(notifications).toBe(1);
      expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
      await sessions.releaseSession(HOLDER, reason);
      pool.releaseRehydrationReservation(HOLDER);
      timer.advanceTime(DEVICE_RESTART_RECOVERY_WINDOW_MS);
      expect(notifications).toBe(1);
    });
  }
  test("expiry at exactly the recovery deadline frees the device once", async () => {
    await setup();
    await keepIdlePastRecovery();
    await handoff();
    await advance(179_999);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    await advance(1);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(notifications).toBe(1);
    pool.releaseRehydrationReservation(HOLDER);
    pool.releaseDeviceClaimsForShutdown();
    expect(notifications).toBe(1);
  });
  test("pins: never-resumed restart row expires at 120 seconds and is refused after 180 seconds", async () => {
    await setup();
    await handoff();
    const row = await persistence.getSession(HOLDER);
    expect(row?.daemon_session_id).toBe(DAEMON_A);
    expect(row?.expires_at_ms).toBe(timer.now() + 120_000);
    let expiryNotices = 0;
    sessions.onSessionRelease((_id, _device, reason) => {
      if (reason === "expired") {
        expiryNotices++;
      }
    });
    await advance(120_000);
    expect((await persistence.getSession(HOLDER))?.release_reason).toBe("expired");
    expect(internals.rehydrationReservations.size).toBe(0);
    expect(pool.getDevice(SIM.deviceId)?.sessionId).toBeNull();
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(notifications).toBe(1);
    expect(expiryNotices).toBe(1);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true),
      ).rejects.toMatchObject({
        release: { releaseReason: "expired" },
      });
    }
    await advance(60_001);
    expect(await persistence.getSession(HOLDER)).toMatchObject({
      status: "expired",
      release_reason: "expired",
    });
    await expect(sessions.admitIssuedSessionForAutomation(HOLDER)).rejects.toMatchObject({
      release: { releaseReason: "expired", terminal: true },
    });
    expect(pool.getDevice(SIM.deviceId)?.sessionId).toBeNull();
    expect(expiryNotices).toBe(1);
    expect(notifications).toBe(1);
  });
  test("an idle-ended restart reservation carries idle on both refusal wires after 180 seconds", async () => {
    await handoff();
    await advance(180_001);
    const error = await sessions.admitIssuedSessionForAutomation(HOLDER).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (!(error instanceof TerminalSessionError)) {
      throw new Error("expected the expired reservation's terminal refusal");
    }
    expect(
      sessionOwnershipLostPayload({
        message: error.message,
        sessionUuid: HOLDER,
        reason: error.release.releaseReason,
        release: error.release,
      }).error,
    ).toMatchObject({
      code: "session_ownership_lost",
      reason: "expired",
      idle: true,
      retryable: false,
      nextAction: "acquire_new_session",
    });
    expect(mcpRequestFailureDetails(error, undefined).details).toEqual({
      sessionUuid: HOLDER,
      reason: "expired",
      idle: true,
    });
    expect(pool.getDevice(SIM.deviceId)?.sessionId).toBeNull();
  });

  async function useLongIdleWindow() {
    const session = sessions.getSession(HOLDER)!;
    session.sessionTimeoutMs = 300_000;
    session.expiresAt = timer.now() + 300_000;
    const row = (await persistence.getSession(HOLDER))!;
    row.session_timeout_ms = 300_000;
    row.expires_at_ms = session.expiresAt;
  }

  test("a never-resumed 300-second idle row ends terminally at the recovery window", async () => {
    await useLongIdleWindow();
    await handoff();
    let notices = 0;
    sessions.onSessionRelease((_id, _device, reason) => {
      if (reason === "restart-recovery-timeout") {
        notices++;
      }
    });
    await advance(180_001);
    expect(await persistence.getSession(HOLDER)).toMatchObject({
      status: "expired",
      release_reason: "restart-recovery-timeout",
    });
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    for (const admission of [
      () => sessions.admitIssuedSessionForAutomation(HOLDER),
      () => sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true),
    ]) {
      const error = await admission().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TerminalSessionError);
      if (!(error instanceof TerminalSessionError)) {
        throw new Error("expected terminal refusal");
      }
      expect(error.release).toMatchObject({
        releaseReason: "restart-recovery-timeout",
        terminal: true,
      });
      const wire = sessionOwnershipLostPayload({
        message: error.message,
        sessionUuid: HOLDER,
        reason: error.release.releaseReason,
        release: error.release,
      }).error;
      expect(wire).toMatchObject({
        code: "session_ownership_lost",
        reason: "restart-recovery-timeout",
        retryable: false,
        nextAction: "acquire_new_session",
      });
      expect(wire).not.toHaveProperty("idle");
      expect(mcpRequestFailureDetails(error, undefined).details).toEqual({
        sessionUuid: HOLDER,
        reason: "restart-recovery-timeout",
      });
    }
    expect(await sessions.getReleasedSessionReason(HOLDER)).toBe("restart-recovery-timeout");
    expect(pool.getDevice(SIM.deviceId)?.sessionId).toBeNull();
    expect(await newcomer()).toMatchObject({ assignedDevice: SIM.deviceId });
    await advance(180_000);
    expect(notices).toBe(1);
  });

  test("a 300-second idle owner resumes at 179 seconds and cancels window expiry", async () => {
    await useLongIdleWindow();
    await handoff();
    await advance(179_000);
    expect(await sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true)).toMatchObject({
      assignedDevice: SIM.deviceId,
    });
    await advance(1_001);
    expect(await persistence.getSession(HOLDER)).toMatchObject({
      status: "active",
      release_reason: null,
    });
    expect(pool.getDevice(SIM.deviceId)?.sessionId).toBe(HOLDER);
  });

  test("failed peer discovery at window expiry drops the hold without writing or fencing", async () => {
    await useLongIdleWindow();
    await handoff();
    const before = { ...(await persistence.getSession(HOLDER))! };
    sessions.attachLiveDaemonSessionIds(() => {
      throw new Error("live daemon discovery unavailable");
    });
    let notices = 0;
    sessions.onSessionRelease(() => {
      notices++;
    });
    await advance(180_000);
    await expect(sessions.expireRestartRecoveryReservation(HOLDER)).resolves.toBeUndefined();
    expect(internals.rehydrationReservations.has(HOLDER)).toBe(false);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(await persistence.getSession(HOLDER)).toEqual(before);
    expect(sessions.getTerminalReleaseSnapshot(HOLDER)).toBeUndefined();
    expect(notices).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("recovery activity extends idle expiry but never the handoff window", async () => {
    await handoff();
    await absent();
    const waiting = sessions
      .getOrCreateSession(HOLDER, pool, "ios", undefined, true, {
        requestDeadlineMs: timer.now() + 30_000,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    await drainMicrotasks(40);
    await advance(30_000);
    await waiting;
    await advance(70_000);
    sessions.recordToolCallEnded(HOLDER);
    await drainMicrotasks(40);
    expect((await persistence.getSession(HOLDER))?.expires_at_ms).toBe(221_000);
    await advance(80_000);
    expect(await persistence.getSession(HOLDER)).toMatchObject({
      status: "expired",
      release_reason: "restart-recovery-timeout",
    });
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
  });

  test("window expiry journals before the conditional write and resolves the intent", async () => {
    await useLongIdleWindow();
    await handoff();
    const intents: TerminalReleaseIntent[] = [];
    const events: string[] = [];
    sessions.attachTerminalReleaseJournal({
      loadUnconfirmed: () => [],
      record: (intent) => {
        intents.push(intent);
        events.push("journal");
      },
      resolve: () => {
        events.push("resolve");
      },
    });
    const original = persistence.markReleased.bind(persistence);
    persistence.markReleased = async (...args) => {
      if (args[3] === "restart-recovery-timeout") {
        events.push("write");
        expect(args[4]).toMatchObject({
          expectedRowGeneration: 1,
          onlyIfOwnedByDaemon: DAEMON_A,
          onlyIfRecoverable: true,
          onlyIfRestartRecoveryHandoff: {
            releasedAtOrBeforeMs: 1_000,
            recoveryWindowMs: DEVICE_RESTART_RECOVERY_WINDOW_MS,
          },
        });
      }
      await original(...args);
    };
    await advance(180_000);
    expect(events).toEqual(["journal", "write", "resolve"]);
    expect(intents).toEqual([
      { sessionId: HOLDER, reason: "restart-recovery-timeout", at: 181_000 },
    ]);
  });

  test("a same-generation handoff change racing window expiry raises no local fence", async () => {
    await useLongIdleWindow();
    await handoff();
    const original = persistence.markReleased.bind(persistence);
    persistence.markReleased = async (...args) => {
      if (args[3] === "restart-recovery-timeout") {
        await original(HOLDER, "released", timer.now(), "daemon-shutdown");
      }
      await original(...args);
    };
    let notices = 0;
    sessions.onSessionRelease((_id, _device, _reason, snapshot) => {
      if (snapshot.terminal) {
        notices++;
      }
    });
    await advance(180_000);
    expect(await persistence.getSession(HOLDER)).toMatchObject({
      release_reason: "daemon-shutdown",
      status: "released",
    });
    expect(sessions.getTerminalReleaseSnapshot(HOLDER)).toBeUndefined();
    expect(notices).toBe(0);
  });

  for (const race of [false, true]) {
    test(`a live peer claim at window lapse is preserved, racing write: ${race}`, async () => {
      await useLongIdleWindow();
      sessions.attachLiveDaemonSessionIds(() => new Set([DAEMON_A, DAEMON_B]));
      await handoff();
      const claim = async () => {
        const row = (await persistence.getSession(HOLDER))!;
        await persistence.claimRecoverableSession(
          HOLDER,
          { rowGeneration: row.stable_identity_generation!, daemonSessionId: DAEMON_A },
          DAEMON_B,
        );
      };
      let notices = 0;
      sessions.onSessionRelease((_id, _device, _reason, snapshot) => {
        if (snapshot.terminal) {
          notices++;
        }
      });
      if (race) {
        const original = persistence.markReleased.bind(persistence);
        persistence.markReleased = async (...args) => {
          if (args[3] === "restart-recovery-timeout") {
            await claim();
          }
          await original(...args);
        };
      } else {
        await claim();
      }
      await advance(180_000);
      expect(await persistence.getSession(HOLDER)).toMatchObject({
        status: "released",
        release_reason: `device-restart:${SIM.name}`,
        daemon_session_id: DAEMON_B,
        stable_identity_generation: 2,
      });
      expect(notices).toBe(0);
      expect(sessions.getTerminalReleaseSnapshot(HOLDER)).toBeUndefined();
      expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    });
  }

  for (const livePeer of [true, false]) {
    test(`a peer claim before idle expiry is preserved, live peer: ${livePeer}`, async () => {
      sessions.attachLiveDaemonSessionIds(
        () => new Set(livePeer ? [DAEMON_A, DAEMON_B] : [DAEMON_A]),
      );
      await handoff();
      const row = (await persistence.getSession(HOLDER))!;
      const previousGeneration = row.stable_identity_generation!;
      const claimedGeneration = await persistence.claimRecoverableSession(
        HOLDER,
        { rowGeneration: previousGeneration, daemonSessionId: DAEMON_A },
        DAEMON_B,
      );
      expect(claimedGeneration).toBe(previousGeneration + 1);
      let terminalNotices = 0;
      sessions.onSessionRelease((_id, _device, _reason, snapshot) => {
        if (snapshot.terminal) {
          terminalNotices++;
        }
      });
      await advance(120_000);
      expect(await persistence.getSession(HOLDER)).toMatchObject({
        release_reason: `device-restart:${SIM.name}`,
        daemon_session_id: DAEMON_B,
        stable_identity_generation: claimedGeneration,
      });
      expect(terminalNotices).toBe(0);
      expect(pool.genericAvailability(SIM.deviceId)).toBe(livePeer ? "reserved" : "free");
      await advance(59_999);
      expect(pool.genericAvailability(SIM.deviceId)).toBe(livePeer ? "reserved" : "free");
      await advance(1);
      expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
      expect((await persistence.getSession(HOLDER))?.release_reason).toBe(
        `device-restart:${SIM.name}`,
      );
      expect(terminalNotices).toBe(0);
    });
  }
  test("a live peer's later release timestamp cannot extend the pool's recovery window", async () => {
    sessions.attachLiveDaemonSessionIds(() => new Set([DAEMON_A, DAEMON_B]));
    const handoffAt = timer.now();
    await handoff();
    const row = (await persistence.getSession(HOLDER))!;
    await persistence.claimRecoverableSession(
      HOLDER,
      { rowGeneration: row.stable_identity_generation!, daemonSessionId: DAEMON_A },
      DAEMON_B,
    );
    row.released_at_ms = handoffAt + 60_000;
    await advance(120_000);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    await advance(59_999);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    await advance(1);
    expect(timer.now()).toBe(handoffAt + DEVICE_RESTART_RECOVERY_WINDOW_MS);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(row).toMatchObject({
      daemon_session_id: DAEMON_B,
      release_reason: `device-restart:${SIM.name}`,
    });
  });
  test("a peer claim racing the expiry write keeps the live peer's hold without a terminal notice", async () => {
    sessions.attachLiveDaemonSessionIds(() => new Set([DAEMON_A, DAEMON_B]));
    await handoff();
    let terminalNotices = 0;
    sessions.onSessionRelease((_id, _device, _reason, snapshot) => {
      if (snapshot.terminal) {
        terminalNotices++;
      }
    });
    const markReleased = persistence.markReleased.bind(persistence);
    let expiryOptions: Parameters<typeof markReleased>[4];
    let claimedGeneration: number | undefined;
    persistence.markReleased = async (...args) => {
      if (args[3] === "expired") {
        expiryOptions = args[4];
        const row = (await persistence.getSession(HOLDER))!;
        claimedGeneration = await persistence.claimRecoverableSession(
          HOLDER,
          { rowGeneration: row.stable_identity_generation!, daemonSessionId: DAEMON_A },
          DAEMON_B,
        );
      }
      await markReleased(...args);
    };
    await advance(120_000);
    expect(await persistence.getSession(HOLDER)).toMatchObject({
      release_reason: `device-restart:${SIM.name}`,
      daemon_session_id: DAEMON_B,
      stable_identity_generation: claimedGeneration,
    });
    expect(terminalNotices).toBe(0);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    expect(expiryOptions?.onlyIfOwnedByDaemon).toBe(DAEMON_A);
    await advance(60_000);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect((await persistence.getSession(HOLDER))?.release_reason).toBe(
      `device-restart:${SIM.name}`,
    );
    expect(terminalNotices).toBe(0);
  });
  test("a forced restart release resolves its notified persistence promise and expires at idle", async () => {
    const android: BootedDevice = {
      deviceId: "emulator-5554",
      name: "restart-avd",
      platform: "android",
    };
    await setup([android]);
    sessions.setKeepScreenAwake(HOLDER, { applied: true, method: "settings" });
    let releasePersisted: Promise<void> | undefined;
    let persisted = false;
    sessions.onSessionRelease((_id, _device, reason, _snapshot, options) => {
      if (reason.startsWith("device-restart:")) {
        releasePersisted = options.releasePersisted;
        void releasePersisted?.then(() => {
          persisted = true;
        });
      }
    });
    const releasing = internals.releaseDisconnectedRecoverySessionWithRetry(
      HOLDER,
      android.deviceId,
      `device-restart:${android.name}`,
    );
    try {
      await drainUntil(() => keepAwakeStarted, {
        description: "parked restart teardown",
      });
      expect(sessions.forceStuckRelease(HOLDER)?.stage).toBe("teardown");
      await drainMicrotasks(40);
      expect((await persistence.getSession(HOLDER))?.release_reason).toBe(
        `device-restart:${android.name}`,
      );
      expect(releasePersisted).toBeDefined();
      expect(persisted).toBe(true);
      expect(internals.rehydrationReservations.get(HOLDER)?.releasePersistence).toBeUndefined();
      await advance(120_000);
      expect(internals.rehydrationReservations.has(HOLDER)).toBe(false);
      expect((await persistence.getSession(HOLDER))?.release_reason).toBe("expired");
    } finally {
      keepAwakeGate.resolve();
      await releasing;
    }
  });
  test("a failed forced restart release retries its fence, resolves persistence and expires at idle", async () => {
    const android: BootedDevice = {
      deviceId: "emulator-5554",
      name: "restart-avd",
      platform: "android",
    };
    await setup([android]);
    sessions.setTerminalReleaseRetryBackoff(fixedBackoff(1_000));
    sessions.setKeepScreenAwake(HOLDER, { applied: true, method: "settings" });
    const idleDeadline = sessions.getSession(HOLDER)!.expiresAt;
    let releasePersisted: Promise<void> | undefined;
    let persisted = false;
    sessions.onSessionRelease((_id, _device, reason, _snapshot, options) => {
      if (reason.startsWith("device-restart:")) {
        releasePersisted = options.releasePersisted;
        void releasePersisted?.then(() => {
          persisted = true;
        });
      }
    });
    const releasing = internals.releaseDisconnectedRecoverySessionWithRetry(
      HOLDER,
      android.deviceId,
      `device-restart:${android.name}`,
    );
    try {
      await drainUntil(() => keepAwakeStarted, {
        description: "parked restart teardown before failed forced write",
      });
      persistence.failure = "release";
      expect(sessions.forceStuckRelease(HOLDER)?.stage).toBe("teardown");
      await drainMicrotasks(40);
      expect(await persistence.getSession(HOLDER)).toMatchObject({
        status: "active",
        release_reason: null,
      });
      expect(releasePersisted).toBeDefined();
      expect(persisted).toBe(false);
      persistence.failure = null;
      await advance(999);
      expect(persisted).toBe(false);
      await advance(1);
      expect(await persistence.getSession(HOLDER)).toMatchObject({
        status: "released",
        release_reason: `device-restart:${android.name}`,
      });
      expect(persisted).toBe(true);
      expect(internals.rehydrationReservations.get(HOLDER)?.releasePersistence).toBeUndefined();
      // Keep teardown parked until the retry has proved it resolves the shared fence promise.
      keepAwakeGate.resolve();
      await releasing;
      await pool.releaseDevice(android.deviceId, HOLDER);
      await advance(idleDeadline - timer.now() - 1);
      expect(pool.genericAvailability(android.deviceId)).toBe("reserved");
      await advance(1);
      expect(pool.genericAvailability(android.deviceId)).toBe("free");
      expect((await persistence.getSession(HOLDER))?.release_reason).toBe("expired");
    } finally {
      persistence.failure = null;
      keepAwakeGate.resolve();
      await releasing;
    }
  });
  test("tool activity during recovery extends the idle hold", async () => {
    await setup();
    await handoff();
    // An already admitted call ends after loss; the existing recovery-activity seam credits it.
    await absent();
    const waiting = sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true, {
      requestDeadlineMs: timer.now() + 30_000,
    });
    const outcome = waiting.catch((error: unknown) => error);
    await drainMicrotasks(40);
    await advance(30_000);
    await outcome;
    await advance(80_000);
    sessions.recordToolCallEnded(HOLDER);
    await advance(10_000);
    expect(internals.rehydrationReservations.has(HOLDER)).toBe(true);
    await returned();
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    await advance(59_999);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    await advance(1);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(notifications).toBe(1);
  });
  test("an in-flight recovery call retains the hold past idle expiry until 180 seconds", async () => {
    await setup();
    await handoff();
    let inFlight = true;
    sessions.setActiveSessionExecutionChecker(() => inFlight);
    await advance(120_000);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    expect((await persistence.getSession(HOLDER))?.release_reason).toStartWith("device-restart:");
    await advance(59_999);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    await advance(1);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(notifications).toBe(1);
    inFlight = false;
  });
  for (const daemonFirst of [true, false]) {
    test(`overlapping holds end independently, daemon first: ${daemonFirst}`, async () => {
      await setup();
      const reserveDaemon = () =>
        pool.reserveDevicesForRehydration([
          {
            sessionId: HOLDER,
            target: { platform: "ios", stableDeviceId: SIM.deviceId, deviceId: SIM.deviceId },
          },
        ]);
      if (daemonFirst) {
        await reserveDaemon();
      }
      await handoff();
      if (!daemonFirst) {
        await reserveDaemon();
      }
      pool.releaseRehydrationReservation(HOLDER);
      pool.releaseRehydrationReservation(HOLDER);
      expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
      expect(notifications).toBe(0);
      await sessions.releaseSession(HOLDER, "heartbeat-timeout");
      expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
      expect(notifications).toBe(1);
      await sessions.releaseSession(HOLDER, "heartbeat-timeout");
      await advance(180_000);
      expect(notifications).toBe(1);
    });
  }
  test("resuming the handoff leaves the daemon batch's hold intact", async () => {
    await setup();
    await handoff();
    await pool.reserveDevicesForRehydration([
      {
        sessionId: HOLDER,
        target: { platform: "ios", stableDeviceId: SIM.deviceId, deviceId: SIM.deviceId },
      },
    ]);
    await sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true);
    expect(internals.rehydrationReservations.has(HOLDER)).toBe(true);
    expect(notifications).toBe(0);
    pool.releaseRehydrationReservation(HOLDER);
    pool.releaseRehydrationReservation(HOLDER);
    expect(notifications).toBe(1);
  });
  test("a stalled idle-expiry read cannot extend the cold-boot hold", async () => {
    await setup();
    await handoff();
    const read = persistence.getSession.bind(persistence);
    const gate = Promise.withResolvers<void>();
    persistence.getSession = async (sessionId) => {
      await gate.promise;
      return read(sessionId);
    };
    await advance(120_000);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    await advance(60_000);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(notifications).toBe(1);
    gate.resolve();
    await drainMicrotasks(40);
    persistence.getSession = read;
    expect(notifications).toBe(1);
  });
  test("a call ending after idle expiry re-arms its extended idle deadline", async () => {
    await setup();
    const session = sessions.getSession(HOLDER)!;
    session.sessionTimeoutMs = 10_000;
    session.expiresAt = timer.now() + 10_000;
    const row = (await persistence.getSession(HOLDER))!;
    row.session_timeout_ms = 10_000;
    row.expires_at_ms = session.expiresAt;
    await handoff();
    // Register activity through the real recovery call, then keep an admitted call in flight.
    await absent();
    const waiting = sessions
      .getOrCreateSession(HOLDER, pool, "ios", undefined, true, {
        requestDeadlineMs: timer.now() + 2_000,
      })
      .catch((error: unknown) => error);
    await drainMicrotasks(40);
    await advance(1_000);
    await waiting;
    let inFlight = true;
    sessions.setActiveSessionExecutionChecker(() => inFlight);
    await advance(10_000);
    expect(internals.rehydrationReservations.has(HOLDER)).toBe(true);
    inFlight = false;
    sessions.recordToolCallEnded(HOLDER);
    await returned();
    await advance(9_999);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    await advance(1);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect((await persistence.getSession(HOLDER))?.release_reason).toBe("expired");
    expect(notifications).toBe(1);
  });
  test("terminal handoff timeout ends a longer daemon batch hold", async () => {
    await setup();
    await keepIdlePastRecovery();
    await handoff();
    await pool.reserveDevicesForRehydration([
      {
        sessionId: HOLDER,
        target: { platform: "ios", stableDeviceId: SIM.deviceId, deviceId: SIM.deviceId },
      },
    ]);
    await advance(180_000);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect((await persistence.getSession(HOLDER))?.release_reason).toBe("restart-recovery-timeout");
    expect(notifications).toBe(1);
    pool.releaseRehydrationReservation(HOLDER);
    pool.releaseRehydrationReservation(HOLDER);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(notifications).toBe(1);
  });
  for (const reason of ["device-killed", "explicit-release", "heartbeat-timeout"] as const) {
    test(`${reason} immediately ends both overlapping holds exactly once`, async () => {
      await setup();
      await handoff();
      await pool.reserveDevicesForRehydration([
        {
          sessionId: HOLDER,
          target: { platform: "ios", stableDeviceId: SIM.deviceId, deviceId: SIM.deviceId },
        },
      ]);
      await sessions.releaseSession(HOLDER, reason);
      expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
      expect(internals.rehydrationReservations.size).toBe(0);
      expect(notifications).toBe(1);
      await sessions.releaseSession(HOLDER, reason);
      await advance(180_000);
      expect(notifications).toBe(1);
    });
  }
  for (const reason of ["device-killed", "explicit-release"] as const) {
    test(`holder ${reason} before loss creates no handoff`, async () => {
      await setup();
      const device = pool.getDevice(SIM.deviceId)!;
      await sessions.releaseSession(HOLDER, reason);
      await pool.retireDeviceForShutdown(device);
      expect(internals.rehydrationReservations.size).toBe(0);
      expect(notifications).toBe(0);
      await returned();
      expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
      await expect(
        pool.bindOrReuseDeviceSession("newcomer", SIM.deviceId, "ios", undefined, undefined, SIM),
      ).resolves.toBe("newcomer");
    });
  }
  test("an intentional stop without a session id preserves both reservation sources", async () => {
    await handoff();
    await pool.reserveDevicesForRehydration([
      {
        sessionId: HOLDER,
        target: { platform: "ios", stableDeviceId: SIM.deviceId, deviceId: SIM.deviceId },
      },
    ]);
    pool.markIntentionalShutdown(SIM.deviceId);
    expect(internals.rehydrationReservations.get(HOLDER)).toMatchObject({
      restartHandoff: true,
      daemonRehydration: true,
    });
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
  });
  test("another session's intentional stop preserves the handoff hold", async () => {
    await handoff();
    pool.markIntentionalShutdown(SIM.deviceId, "someone-else");
    expect(internals.rehydrationReservations.get(HOLDER)?.restartHandoff).toBe(true);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
  });
  test("a live base's stop drops its handed-off label session's hold", async () => {
    const base = "live-base";
    await sessions.createSession(base, SPARE.deviceId, "ios");
    sessions.setDeviceLabels(base, { phone: `${base}:phone` });
    await sessions.releaseSession(HOLDER, "explicit-release");
    await pool.releaseDevice(SIM.deviceId, HOLDER);
    const closeMint = sessions.openPlanLabelMints(base, { phone: `${base}:phone` });
    await pool.bindOrReuseDeviceSession(
      `${base}:phone`,
      SIM.deviceId,
      "ios",
      undefined,
      undefined,
      SIM,
    );
    closeMint();
    await internals.releaseDisconnectedRecoverySessionWithRetry(
      `${base}:phone`,
      SIM.deviceId,
      `device-restart:${SIM.name}`,
    );
    await pool.releaseDevice(SIM.deviceId, `${base}:phone`);
    expect(sessions.getDeviceLabels(base)).toEqual({ phone: `${base}:phone` });
    expect(internals.rehydrationReservations.get(`${base}:phone`)?.restartHandoff).toBe(true);
    pool.markIntentionalShutdown(SIM.deviceId, base);
    expect(internals.rehydrationReservations.has(`${base}:phone`)).toBe(false);
  });
  test("a handed-off base's label requester leaves its unresolved hold intact", async () => {
    sessions.setDeviceLabels(HOLDER, { phone: `${HOLDER}:phone` });
    await handoff();
    expect(sessions.getDeviceLabels(HOLDER)).toBeUndefined();
    pool.markIntentionalShutdown(SIM.deviceId, `${HOLDER}:phone`);
    expect(internals.rehydrationReservations.get(HOLDER)?.restartHandoff).toBe(true);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
  });
  test("a holder's intentional stop ends only its handoff source and timer", async () => {
    await handoff();
    await pool.reserveDevicesForRehydration([
      {
        sessionId: HOLDER,
        target: { platform: "ios", stableDeviceId: SIM.deviceId, deviceId: SIM.deviceId },
      },
    ]);
    expect(internals.rehydrationReservations.get(HOLDER)?.expiryTimer).toBeDefined();
    pool.markIntentionalShutdown(SIM.deviceId, HOLDER);
    expect(internals.rehydrationReservations.get(HOLDER)).toMatchObject({
      restartHandoff: false,
      daemonRehydration: true,
    });
    expect(internals.rehydrationReservations.get(HOLDER)?.expiryTimer).toBeUndefined();
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    await advance(180_000);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    pool.releaseRehydrationReservation(HOLDER);
    expect(internals.rehydrationReservations.has(HOLDER)).toBe(false);
    // The intentional-shutdown fence remains until the platform stop settles.
    pool.clearIntentionalShutdown(SIM.deviceId);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(notifications).toBe(1);
  });
  test("a holder's intentional stop drops an existing recovery hold immediately", async () => {
    await setup();
    await handoff();
    pool.markIntentionalShutdown(SIM.deviceId, HOLDER);
    expect(internals.rehydrationReservations.has(HOLDER)).toBe(false);
    await sessions.releaseSession(HOLDER, "explicit-release");
    // The platform shutdown marker is a separate fence until the stop completes.
    pool.clearIntentionalShutdown(SIM.deviceId);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    await advance(180_000);
    expect(notifications).toBe(1);
  });
  test("expiry leaves the existing terminal target-absent answer unchanged", async () => {
    await setup();
    await handoff();
    await absent();
    // A configured idle window longer than recovery isolates the cold-boot deadline.
    const row = await persistence.getSession(HOLDER);
    if (!row) {
      throw new Error("expected a restart row");
    }
    row.session_timeout_ms = 600_000;
    row.expires_at_ms = 601_000;
    timer.advanceTime(179_000);
    const waiting = sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true);
    const outcome = waiting.then(
      (session) => session,
      (error: unknown) => error,
    );
    await drainMicrotasks(200);
    await timer.advanceTimeAsync(1_000, () => drainMicrotasks(200));
    expect(await outcome).toMatchObject({ reason: "target-absent" });
    expect((await persistence.getSession(HOLDER))?.release_reason).toBe(
      "identity-recovery-target-absent",
    );
    expect(notifications).toBe(1);
  });
  test("start admission reads the hold without reserving readiness or changing its deadline", async () => {
    await handoff();
    const held = internals.rehydrationReservations.get(HOLDER);
    await advance(12_345);
    expect(pool.restartReservationForStart("ios", [SIM.deviceId], {})).toMatchObject({
      sessionUuid: HOLDER,
      owned: false,
      deviceId: SIM.deviceId,
      retryAfterMs: 107_655,
    });
    expect(
      pool.restartReservationForStart("ios", [SIM.deviceId], { sessionUuid: HOLDER })?.owned,
    ).toBe(true);
    expect(pool.isReservedForReadiness(SIM.deviceId)).toBe(false);
    expect(internals.rehydrationReservations.get(HOLDER)).toBe(held);
  });
  test("managed slot priority applies to start admission even after a hold was made", async () => {
    await setup([SIM], true);
    await handoff();
    managed = true;
    expect(pool.restartReservationForStart("ios", [SIM.deviceId], {})).toBeUndefined();
    expect(internals.rehydrationReservations.get(HOLDER)?.restartHandoff).toBe(true);
  });
  test("shutdown releases once and cancels the timer", async () => {
    await setup();
    await handoff();
    pool.releaseDeviceClaimsForShutdown();
    pool.releaseDeviceClaimsForShutdown();
    timer.advanceTime(DEVICE_RESTART_RECOVERY_WINDOW_MS);
    expect(notifications).toBe(1);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
  test("a second handoff refreshes its own hold, without duplicating it", async () => {
    await setup();
    await keepIdlePastRecovery();
    await handoff();
    timer.advanceTime(1_000);
    await sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true);
    await keepIdlePastRecovery();
    await handoff();
    await advance(179_000);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    expect(internals.rehydrationReservations.size).toBe(1);
    await advance(1_000);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(notifications).toBe(1);
  });
  test("the first holder of a target keeps it", async () => {
    await setup();
    await pool.reserveDevicesForRehydration([
      {
        sessionId: "first",
        target: { platform: "ios", stableDeviceId: SIM.deviceId, deviceId: SIM.deviceId },
      },
    ]);
    await handoff();
    expect([...internals.rehydrationReservations.keys()]).toEqual(["first"]);
    timer.advanceTime(DEVICE_RESTART_RECOVERY_WINDOW_MS);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
  });
  test("daemon-restart hold survives unrelated creation and its own session's creation", async () => {
    await setup([SIM, SPARE]);
    await sessions.releaseSession(HOLDER, "daemon-shutdown");
    await pool.releaseDevice(SIM.deviceId, HOLDER);
    await pool.reserveDevicesForRehydration([
      {
        sessionId: HOLDER,
        target: { platform: "ios", stableDeviceId: SIM.deviceId, deviceId: SIM.deviceId },
      },
    ]);
    expect(await newcomer()).toMatchObject({ assignedDevice: SPARE.deviceId });
    expect(internals.rehydrationReservations.has(HOLDER)).toBe(true);
    await sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true);
    expect(pool.getDevice(SIM.deviceId)?.sessionId).toBe(HOLDER);
    expect(internals.rehydrationReservations.has(HOLDER)).toBe(true);
    // The rehydration batch, rather than creation, still owns this hold's end (#11294).
    pool.releaseRehydrationReservation(HOLDER);
    expect(internals.rehydrationReservations.size).toBe(0);
  });
  test("the hold is installed before the release attempt begins", async () => {
    await setup();
    await internals.releaseDisconnectedRecoverySessionWithRetry(
      HOLDER,
      SIM.deviceId,
      `device-restart:${SIM.deviceId}`,
      async () => {
        expect(internals.rehydrationReservations.has(HOLDER)).toBe(true);
        await sessions.releaseSession(HOLDER, `device-restart:${SIM.deviceId}`);
      },
    );
    expect(internals.rehydrationReservations.has(HOLDER)).toBe(true);
  });
  for (const probe of [
    { name: "past idle deadline with a call in flight", idleOffsetMs: -1, inFlight: true },
    {
      name: "idle deadline 300 ms away with no call in flight",
      idleOffsetMs: 300,
      inFlight: false,
    },
  ]) {
    test(`release persistence retry retains the hold: ${probe.name}`, async () => {
      const session = sessions.getSession(HOLDER)!;
      session.expiresAt = timer.now() + probe.idleOffsetMs;
      const row = (await persistence.getSession(HOLDER))!;
      row.expires_at_ms = session.expiresAt;
      let inFlight = probe.inFlight;
      sessions.setActiveSessionExecutionChecker(() => inFlight);
      let releaseAttempts = 0;
      let expiryNotices = 0;
      let admissions = 0;
      sessions.onSessionCreated(() => admissions++);
      sessions.onSessionRelease((_id, _device, reason) => {
        if (reason === "expired") {
          expiryNotices++;
        }
      });
      const markReleased = persistence.markReleased.bind(persistence);
      persistence.markReleased = async (...args) => {
        if (args[3].startsWith("device-restart:")) {
          releaseAttempts++;
          if (releaseAttempts === 1) {
            throw new Error("transient restart release failure");
          }
        }
        await markReleased(...args);
      };
      const releasing = handoff();
      await drainUntil(() => timer.getPendingSleepCount() === 1, {
        description: "restart release retry backoff",
      });
      expect(releaseAttempts).toBe(1);
      notifications = 0;
      const beforePersistenceMs = Math.max(1, probe.idleOffsetMs + 1);
      await advance(beforePersistenceMs);
      expect(internals.rehydrationReservations.has(HOLDER)).toBe(true);
      expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
      expect(row).toMatchObject({ status: "active", release_reason: null, released_at_ms: null });
      expect(notifications).toBe(0);
      expect(expiryNotices).toBe(0);

      await advance(1_000 - beforePersistenceMs);
      await releasing;
      expect(releaseAttempts).toBe(2);
      expect(row).toMatchObject({
        status: "released",
        release_reason: `device-restart:${SIM.name}`,
        released_at_ms: 1_000,
      });
      expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
      expect(notifications).toBe(0);
      expect(expiryNotices).toBe(0);
      // Persistence arms the already-past idle deadline for the next timer turn.
      inFlight = false;
      await advance(0);
      expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
      expect(row.release_reason).toBe("expired");
      expect(notifications).toBe(1);
      expect(expiryNotices).toBe(1);
      expect(admissions).toBe(0);
      await advance(DEVICE_RESTART_RECOVERY_WINDOW_MS);
      expect(notifications).toBe(1);
      expect(expiryNotices).toBe(1);
      expect(admissions).toBe(0);
    });
  }
  test("reserved restarting Android capacity is counted exactly once", async () => {
    const android: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
    await setup([android]);
    const source = new FakeAndroidCapacitySource();
    source.emulatorSerials = [android.deviceId];
    source.emulatorProcessRssBytes = [1024 ** 3];
    const gate = new AndroidBootAdmissionGate(source, timer, {
      env: { [ANDROID_MAX_BOOTED_ENV]: "2" },
    });
    const before = await gate.describeCapacity();
    await handoff(android);
    // Restarting transport disappears; its process remains the capacity source, not the hold.
    source.emulatorSerials = [];
    expect(pool.genericAvailability(android.deviceId)).toBe("reserved");
    expect(await gate.describeCapacity()).toEqual(before);
    expect(before).toMatchObject({ booted: 1, inFlight: 0 });
  });
});
