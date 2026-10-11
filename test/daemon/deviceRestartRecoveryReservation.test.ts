import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import type { ManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
import {
  DEVICE_RESTART_RECOVERY_WINDOW_MS,
  SessionManager,
  type RehydrationDeviceReservation,
} from "../../src/daemon/sessionManager";
import {
  AndroidBootAdmissionGate,
  ANDROID_MAX_BOOTED_ENV,
} from "../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { ActionableError, type BootedDevice } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeAndroidCapacitySource } from "../fakes/FakeAndroidCapacitySource";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, settleByFakeEvents } from "../helpers/fakeTimerStepping";

const SIM: BootedDevice = { deviceId: "restart-sim", name: "restart-sim", platform: "ios" };
const SPARE: BootedDevice = { deviceId: "spare-sim", name: "spare-sim", platform: "ios" };
const HOLDER = "restart-holder";
interface ReservationInternals {
  releaseDisconnectedRecoverySessionWithRetry(
    sessionId: string,
    deviceId: string,
    reason: SessionReleaseReason,
    attempt?: () => Promise<void>,
  ): Promise<void>;
  notifyRehydrationReservationChanged(target: RehydrationDeviceReservation["target"]): void;
  rehydrationReservations: Map<string, RehydrationDeviceReservation["target"]>;
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
  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    persistence = new FakeDeviceSessionPersistence();
    sessions = new SessionManager(timer, persistence);
    sessions.stopCleanupTimer();
    manager = new FakeDeviceManager();
    managed = false;
    refreshFails = false;
    notifications = 0;
  });
  afterEach(() => {
    pool?.releaseDeviceClaimsForShutdown();
    sessions.stopCleanupTimer();
    timer.reset();
  });
  async function setup(devices: BootedDevice[] = [SIM], withSlots = false) {
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
    await handoff();
    timer.advanceTime(179_999);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    timer.advanceTime(1);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
    expect(notifications).toBe(1);
    pool.releaseRehydrationReservation(HOLDER);
    pool.releaseDeviceClaimsForShutdown();
    expect(notifications).toBe(1);
  });
  test("idle expiry at 120 seconds ends the hold with no recovery call waiting", async () => {
    await setup();
    await handoff();
    const row = await persistence.getSession(HOLDER);
    expect(row?.expires_at_ms).toBe(timer.now() + 120_000);
    timer.advanceTime(120_000);
    // No recovery was started during the hold. Admission now terminalizes the expired row.
    await expect(
      sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true),
    ).rejects.toMatchObject({ release: { releaseReason: "expired" } });
    expect((await persistence.getSession(HOLDER))?.release_reason).toBe("expired");
    expect(internals.rehydrationReservations.size).toBe(0);
    expect(pool.getDevice(SIM.deviceId)?.sessionId).toBeNull();
    expect(pool.genericAvailability(SIM.deviceId)).toBe("free");
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
    await handoff();
    timer.advanceTime(1_000);
    await sessions.getOrCreateSession(HOLDER, pool, "ios", undefined, true);
    await handoff();
    timer.advanceTime(179_000);
    expect(pool.genericAvailability(SIM.deviceId)).toBe("reserved");
    expect(internals.rehydrationReservations.size).toBe(1);
    timer.advanceTime(1_000);
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
