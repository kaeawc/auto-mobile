import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import type { ManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import {
  SESSION_REHYDRATION_DEADLINE_MS,
  SessionManager,
  type RehydrationDeviceReservation,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, settleWithFakeTime } from "../helpers/fakeTimerStepping";

// #11294: daemon restart recovery reserves each persisted row's device up front, so an allocation
// arriving while rows recover a few at a time cannot take a device a later row is about to recover
// onto. Owner decision: release on failure, managed slots win, and the row's own recovery is exempt
// from its reservation by session id.

const SIM_A = "SIM-ROW-A";
const SIM_B = "SIM-ROW-B";
const ios = (deviceId: string): BootedDevice => ({ deviceId, name: deviceId, platform: "ios" });
const reservation = (sessionId: string, deviceId: string): RehydrationDeviceReservation => ({
  sessionId,
  target: { platform: "ios", stableDeviceId: deviceId, deviceId },
});

async function seedRestartReleasedRow(
  persistence: FakeDeviceSessionPersistence,
  sessionUuid: string,
  deviceId: string,
  lastUsedAtMs: number,
): Promise<void> {
  await persistence.upsertActiveSession({
    sessionUuid,
    deviceId,
    stableDeviceId: deviceId,
    platform: "ios",
    createdAtMs: 0,
    lastUsedAtMs,
    expiresAtMs: 600_000,
    sessionTimeoutMs: 600_000,
    heartbeatTimeoutMs: 10_000,
    hasReceivedHeartbeat: true,
  });
  await persistence.markReleased(sessionUuid, "released", 0, "daemon-restart");
}

describe("restart recovery device reservation: the pool (#11294)", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let sessions: SessionManager;
  let manager: FakeDeviceManager;
  /** Simulator UDIDs a managed slot holds, as the pool's exclusion reports them. */
  let managedSlotDevices: Set<string>;
  /** The live execution session of the slot holding those devices, if it has one. */
  let managedSlotExecSession: string | null;
  let pool: DevicePool;

  const managedSlotExclusion: ManagedSlotExclusion = {
    refresh: async () => {},
    holderOf: ({ stableIds }) => {
      const stableDeviceId = stableIds.find((id) => id !== undefined && managedSlotDevices.has(id));
      return stableDeviceId === undefined
        ? undefined
        : {
            platform: "ios",
            stableDeviceId,
            holder: "slot",
            scopeKey: "scope",
            slotIndex: 0,
            scopeState: null,
            execSessionUuid: managedSlotExecSession,
          };
    },
    stableIdsFor: () => managedSlotDevices,
  };

  const setUp = async (devices: BootedDevice[], withManagedSlots = false) => {
    manager.bootedDevices = devices;
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "rehydration-reservation", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        ...(withManagedSlots ? { managedSlotExclusion } : {}),
      }),
    );
    await pool.initializeWithDevices(devices);
  };

  const assignGeneric = (sessionId: string) =>
    runWithAbortSignal(new AbortController().signal, () =>
      pool.assignDeviceToSession(sessionId, "ios"),
    );

  beforeEach(() => {
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    sessions = new SessionManager(timer, persistence);
    manager = new FakeDeviceManager();
    managedSlotDevices = new Set();
    managedSlotExecSession = null;
  });

  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  test("generic allocation skips a reserved device and takes it once the reservation is released", async () => {
    await setUp([ios(SIM_A), ios(SIM_B)]);
    await pool.reserveDevicesForRehydration([reservation("row-a", SIM_A)]);

    expect(pool.genericAvailability(SIM_A)).toBe("reserved");
    expect(pool.getStats()).toMatchObject({ total: 2, idle: 1, assigned: 1 });
    expect(await assignGeneric("generic-1")).toBe(SIM_B);

    // Every other device is taken: the next allocation waits on the reservation.
    const waiting = assignGeneric("generic-2");
    await timer.advanceTimeAsync(1_000);
    expect(pool.getDevice(SIM_A)?.sessionId).toBeNull();

    pool.releaseRehydrationReservation("row-a");
    const granted = await settleWithFakeTime(timer, waiting, {
      stepMs: 1_000,
      maxSteps: 10,
      description: "allocation after the reservation is released",
    });

    expect(granted).toBe(SIM_A);
    expect(pool.genericAvailability(SIM_A)).toBe("free");
  });

  test("the row's own recovery is exempt from its reservation", async () => {
    await seedRestartReleasedRow(persistence, "row-a", SIM_A, 10);
    await setUp([ios(SIM_A)]);
    await pool.reserveDevicesForRehydration([reservation("row-a", SIM_A)]);

    const recovered = await sessions.getOrCreateSession("row-a", pool, "ios", undefined, true);

    expect(recovered).toMatchObject({ sessionId: "row-a", assignedDevice: SIM_A });
    expect(sessions.getTerminalReleaseSnapshot("row-a")).toBeUndefined();
  });

  test("another row naming the same device is refused as target-busy and the first keeps it", async () => {
    await seedRestartReleasedRow(persistence, "row-a", SIM_A, 20);
    await seedRestartReleasedRow(persistence, "row-duplicate", SIM_A, 10);
    await setUp([ios(SIM_A)]);
    await pool.reserveDevicesForRehydration([
      reservation("row-a", SIM_A),
      reservation("row-duplicate", SIM_A),
    ]);

    await expect(
      sessions.getOrCreateSession("row-duplicate", pool, "ios", undefined, true),
    ).rejects.toThrow("target-busy");

    expect(pool.getDevice(SIM_A)?.sessionId).toBeNull();
    await expect(
      sessions.getOrCreateSession("row-a", pool, "ios", undefined, true),
    ).resolves.toMatchObject({ assignedDevice: SIM_A });
  });

  test("another session's explicit bind to a reserved device is refused", async () => {
    await setUp([ios(SIM_A)]);
    await pool.reserveDevicesForRehydration([reservation("row-a", SIM_A)]);

    const refusal = await pool
      .bindOrReuseDeviceSession("someone-else", SIM_A, "ios", undefined, undefined, ios(SIM_A))
      .catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
    expect((refusal as Error).message).toContain("row-a");
    expect(pool.getDevice(SIM_A)?.sessionId).toBeNull();
    await expect(
      pool.bindOrReuseDeviceSession("row-a", SIM_A, "ios", undefined, undefined, ios(SIM_A)),
    ).resolves.toBe("row-a");
  });

  test("a device a managed slot already holds is not reserved", async () => {
    managedSlotDevices.add(SIM_A);
    await setUp([ios(SIM_A), ios(SIM_B)], true);

    await pool.reserveDevicesForRehydration([
      reservation("row-a", SIM_A),
      reservation("row-b", SIM_B),
    ]);
    expect(pool.genericAvailability(SIM_A)).toBe("managed_slot");
    expect(pool.genericAvailability(SIM_B)).toBe("reserved");

    // Once the slot lets go, nothing else holds the device: it was never reserved for the row.
    managedSlotDevices.clear();
    expect(pool.genericAvailability(SIM_A)).toBe("free");
  });

  // Managed slots win even when the slot takes the device after the row reserved it: the
  // reservation never blocks the slot, and the row then ends through the normal target-busy path.
  test("a managed slot that acquires a reserved device afterwards takes it from the row", async () => {
    await seedRestartReleasedRow(persistence, "row-a", SIM_A, 10);
    await setUp([ios(SIM_A)], true);
    await pool.reserveDevicesForRehydration([reservation("row-a", SIM_A)]);
    expect(pool.genericAvailability(SIM_A)).toBe("reserved");

    managedSlotDevices.add(SIM_A);
    managedSlotExecSession = "slot-exec";

    await expect(
      pool.bindOrReuseDeviceSession("slot-exec", SIM_A, "ios", undefined, undefined, ios(SIM_A)),
    ).resolves.toBe("slot-exec");
    expect(pool.getDevice(SIM_A)?.sessionId).toBe("slot-exec");

    await expect(
      sessions.getOrCreateSession("row-a", pool, "ios", undefined, true),
    ).rejects.toThrow("target-busy");
    expect(sessions.getTerminalReleaseSnapshot("row-a")).toMatchObject({
      releaseReason: "identity-recovery-target-busy",
    });
  });

  test("a reservation still refuses a session that is not the managed slot's execution", async () => {
    await setUp([ios(SIM_A)], true);
    await pool.reserveDevicesForRehydration([reservation("row-a", SIM_A)]);

    await expect(
      pool.bindOrReuseDeviceSession("someone-else", SIM_A, "ios", undefined, undefined, ios(SIM_A)),
    ).rejects.toMatchObject({ code: DEVICE_OWNED_BY_OTHER_SESSION_CODE });
  });

  test("startup rehydration recovers every reserved row and leaves nothing reserved", async () => {
    await seedRestartReleasedRow(persistence, "row-a", SIM_A, 20);
    await seedRestartReleasedRow(persistence, "row-b", SIM_B, 10);
    await setUp([ios(SIM_A), ios(SIM_B)]);

    await expect(sessions.rehydratePersistedSessions(pool, { concurrency: 1 })).resolves.toEqual({
      rehydrated: ["row-a", "row-b"],
      terminalized: [],
      skipped: [],
      timedOut: false,
    });
    expect(pool.getDevice(SIM_A)?.sessionId).toBe("row-a");
    expect(pool.getDevice(SIM_B)?.sessionId).toBe("row-b");

    await sessions.releaseSession("row-a", "explicit-release");
    await pool.releaseDevice(SIM_A);
    expect(pool.genericAvailability(SIM_A)).toBe("free");
  });
});

describe("restart recovery device reservation: the rehydration batch (#11294)", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let restarted: SessionManager;
  let events: string[];
  let reserved: Set<string>;

  /** Records reservations and assignments in order; hangs or fails the named rows. */
  function reservingPool(
    options: { hung?: ReadonlySet<string>; failing?: ReadonlySet<string> } = {},
  ): SessionDeviceAssigner {
    return {
      async reserveDevicesForRehydration(rows): Promise<void> {
        events.push(
          `reserve:${rows.map((row) => `${row.sessionId}@${row.target.stableDeviceId}`)}`,
        );
        for (const row of rows) {
          reserved.add(row.sessionId);
        }
      },
      releaseRehydrationReservation(sessionId): void {
        if (reserved.delete(sessionId)) {
          events.push(`release:${sessionId}`);
        }
      },
      async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
        events.push(`assign:${sessionId}`);
        if (options.hung?.has(sessionId)) {
          return await new Promise<string>(() => {});
        }
        if (options.failing?.has(sessionId)) {
          throw new Error(`no device for ${sessionId}`);
        }
        const session = await restarted.createSession(
          sessionId,
          target?.deviceId ?? "unknown",
          "ios",
          target?.liveness?.sessionTimeoutMs,
          target?.liveness?.heartbeatTimeoutMs,
          target?.stableDeviceId,
          target?.liveness,
          target?.initialOwnership,
        );
        return session.assignedDevice;
      },
    };
  }

  beforeEach(async () => {
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    events = [];
    reserved = new Set();
    await seedRestartReleasedRow(persistence, "row-a", SIM_A, 20);
    await seedRestartReleasedRow(persistence, "row-b", SIM_B, 10);
    restarted = new SessionManager(timer, persistence);
  });

  afterEach(() => {
    restarted.stopCleanupTimer();
    timer.reset();
  });

  test("every row's device is reserved before the first row starts recovering", async () => {
    await restarted.rehydratePersistedSessions(reservingPool(), { concurrency: 1 });

    expect(events).toEqual([
      `reserve:row-a@${SIM_A},row-b@${SIM_B}`,
      "assign:row-a",
      "release:row-a",
      "assign:row-b",
      "release:row-b",
    ]);
    expect(reserved.size).toBe(0);
  });

  test("a row that fails gives its device back at once, while later rows stay reserved", async () => {
    const pool = reservingPool({ failing: new Set(["row-a"]), hung: new Set(["row-b"]) });

    const rehydration = restarted.rehydratePersistedSessions(pool, { concurrency: 1 });
    await drainMicrotasks(50);

    expect(events).toEqual([
      `reserve:row-a@${SIM_A},row-b@${SIM_B}`,
      "assign:row-a",
      "release:row-a",
      "assign:row-b",
    ]);
    expect([...reserved]).toEqual(["row-b"]);

    await timer.advanceTimeAsync(SESSION_REHYDRATION_DEADLINE_MS);
    await rehydration;
  });

  test("the deadline releases rows that never started, and a row still recovering keeps its device", async () => {
    const pool = reservingPool({ hung: new Set(["row-a", "row-b"]) });

    const rehydration = restarted.rehydratePersistedSessions(pool, { concurrency: 1 });
    await drainMicrotasks(50);
    expect([...reserved]).toEqual(["row-a", "row-b"]);

    await timer.advanceTimeAsync(SESSION_REHYDRATION_DEADLINE_MS - 1);
    expect([...reserved]).toEqual(["row-a", "row-b"]);

    await timer.advanceTimeAsync(1);
    await expect(rehydration).resolves.toMatchObject({ timedOut: true });

    // row-a started and is still recovering; row-b never started before the deadline.
    expect([...reserved]).toEqual(["row-a"]);
    expect(events).toContain("release:row-b");
    expect(events).not.toContain("release:row-a");
  });

  test("an assigner that cannot reserve still rehydrates every row", async () => {
    const { assignDeviceToSession } = reservingPool();

    await expect(
      restarted.rehydratePersistedSessions({ assignDeviceToSession }, { concurrency: 1 }),
    ).resolves.toMatchObject({ rehydrated: ["row-a", "row-b"] });
  });

  test("a reservation that fails does not stop rehydration", async () => {
    const pool = reservingPool();
    pool.reserveDevicesForRehydration = async () => {
      throw new Error("slot registry unreadable");
    };

    await expect(
      restarted.rehydratePersistedSessions(pool, { concurrency: 1 }),
    ).resolves.toMatchObject({ rehydrated: ["row-a", "row-b"] });
  });
});
