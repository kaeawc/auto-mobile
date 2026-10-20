import { makePool } from "../helpers/makePool";
import { bindDevice, markDeviceError, statusOf } from "../../src/daemon/deviceBinding";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import { MissingDeviceLiveness } from "../../src/daemon/missingDeviceLiveness";
import type { Session } from "../../src/daemon/sessionManager";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";

const original: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Binding_AVD",
  platform: "android",
};
const bystander: BootedDevice = {
  deviceId: "emulator-5556",
  name: "Other_AVD",
  platform: "android",
};
const image: DeviceInfo = {
  name: original.name,
  platform: "android",
  source: "local",
  isRunning: true,
};

// The five fields a future single writer must preserve, including fields that
// are deliberately NOT reset by particular writers. Read through getDevice or
// the captured public retirement/recovery object, never the pool's maps.
function binding(device: PooledDevice) {
  return {
    sessionId: device.sessionId,
    status: statusOf(device),
    bindingStatus: device.status,
    health: device.health,
    errorCount: device.errorCount,
    assignmentCount: device.assignmentCount,
    lastUsedAt: device.lastUsedAt,
  };
}
type Binding = ReturnType<typeof binding>;
interface StateChange {
  deviceId: string;
  platform: string;
  binding: Binding;
}

describe("device binding writers current behavior (#11802)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let utils: FakeDeviceUtils;
  let pool: DevicePool;
  let liveness: MissingDeviceLiveness;
  let rebootOverride: boolean | undefined;
  let changes: StateChange[];
  let autolockEnv: string | undefined;

  async function initialize() {
    timer = new FakeTimer();
    timer.setCurrentTime(1000);
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [original, bystander]);
    changes = [];
    rebootOverride = undefined;
    pool = makePool(manager, "binding-characterization", {
      timer,
      deviceManager: utils,
      idGenerator: new FakeIdGenerator(["autolock-owner"]),
      recoveryPolicy: { onLoss: false, maxAttempts: 0 },
      deviceSessionContinuityEnabled: false,
      missingDeviceLivenessFactory: (port) => {
        liveness = new MissingDeviceLiveness({
          ...port,
          shouldRebootDisconnectedAndroidDevice: (device) =>
            rebootOverride ?? port.shouldRebootDisconnectedAndroidDevice(device),
        });
        return liveness;
      },
      onDeviceStateChanged: (deviceId, platform) => {
        changes.push({ deviceId, platform, binding: binding(pool.getDevice(deviceId)!) });
      },
    });
    await pool.initializeWithDevices([original, bystander]);
  }

  function close() {
    manager.stopCleanupTimer();
    timer.reset();
  }

  beforeAll(async () => {
    // Allocation lazily imports its implementation. Warm it outside the 15 ms
    // row budget, as deviceHoldCharacterization and warmedTests already do.
    await initialize();
    try {
      await pool.assignDeviceToSession("warm-allocation", "android");
    } finally {
      close();
    }
  });
  async function arrangeHarness(): Promise<void> {
    autolockEnv = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    await initialize();
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  function arrangedEach<T>(table: readonly T[]) {
    return (name: string, fn: (row: T) => void | Promise<void>, timeout?: number): void => {
      test.each([...table])(
        name,
        async (row: T) => {
          await arrangeHarness();
          await fn(row);
        },
        timeout,
      );
    };
  }
  afterEach(() => {
    close();
    if (autolockEnv === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolockEnv;
    }
  });

  function assertAgreement() {
    for (const device of pool.getAllDevices()) {
      const sessionId = manager.getSessionForDevice(device.id);
      expect(device.sessionId).toBe(sessionId);
      if (statusOf(device) !== "error") {
        expect(device.status === "busy").toBe(sessionId !== null);
      }
      if (sessionId) {
        expect(manager.getSession(sessionId)?.assignedDevice).toBe(device.id);
      }
    }
  }

  async function bindOwner() {
    await pool.bindOrReuseDeviceSession({
      sessionId: "owner",
      deviceId: original.deviceId,
      platform: "android",
      sourceImage: image,
    });
    assertAgreement();
    return pool.getDevice(original.deviceId)!;
  }

  const initial: Binding = {
    sessionId: null,
    status: "idle" as const,
    bindingStatus: "idle" as const,
    health: "ok" as const,
    errorCount: 0,
    assignmentCount: 0,
    lastUsedAt: 1000,
  };
  const owned: Binding = {
    sessionId: "owner",
    status: "busy" as const,
    bindingStatus: "busy" as const,
    health: "ok" as const,
    errorCount: 0,
    assignmentCount: 1,
    lastUsedAt: 1001,
  };

  // These rows add the cross-copy invariant to existing per-route coverage in
  // devicePool.bindingDirection, devicePool.autolock and adbServerResetRecovery.
  // Literal tuples/events additionally pin the writers' differing bookkeeping.
  const rows: Array<{ name: string; run: () => Promise<void> }> = [
    {
      // devicePool.ts initializeWithDevices entry literal.
      name: "initial population",
      run: async () => {
        expect(binding(pool.getDevice(original.deviceId)!)).toEqual(initial);
        expect(changes).toEqual([]);
      },
    },
    {
      // deviceAllocation.ts claimSelectedDeviceForSession; devicePool.ts releaseCapturedDevice.
      name: "allocate and release",
      run: async () => {
        expect(await pool.assignDeviceToSession("owner", "android")).toBe(original.deviceId);
        assertAgreement();
        expect(binding(pool.getDevice(original.deviceId)!)).toEqual(owned);
        pool.recordDeviceError(original.deviceId);
        await manager.releaseSession("owner");
        await pool.releaseDevice(original.deviceId, "owner");
        expect(binding(pool.getDevice(original.deviceId)!)).toEqual({
          ...owned,
          sessionId: null,
          status: "idle" as const,
          bindingStatus: "idle" as const,
          health: "ok" as const,
        });
        expect(changes.map((change) => change.binding)).toEqual([
          owned,
          {
            ...owned,
            sessionId: null,
            status: "idle" as const,
            bindingStatus: "idle" as const,
            health: "ok" as const,
          },
        ]);
      },
    },
    {
      // explicitDeviceBind.ts assignDeviceToBoundSession.
      name: "explicit bind",
      run: async () => {
        await bindOwner();
        expect(binding(pool.getDevice(original.deviceId)!)).toEqual(owned);
        expect(changes).toEqual([
          { deviceId: original.deviceId, platform: "android", binding: owned },
        ]);
      },
    },
    {
      // deviceReplacement.ts releaseCapturedDeviceForShutdown and restoreSystemUiAnrRecoverySession.
      name: "System UI replacement rebind",
      run: async () => {
        const captured = await bindOwner();
        pool.recordDeviceError(original.deviceId);
        const reservation = await pool.reserveDeviceForShutdown(original.deviceId);
        expect(reservation).toBeDefined();
        try {
          const replacement = { ...original, deviceId: "emulator-5558" };
          utils.setBootedDevices("android", [replacement, bystander]);
          const handoff = await pool.replaceDeviceForSystemUiAnrRecovery(
            captured,
            replacement,
            image,
          );
          await handoff.validatePreservedSession();
          expect(binding(captured)).toEqual({
            ...owned,
            sessionId: null,
            status: "idle" as const,
            bindingStatus: "idle" as const,
            health: "ok" as const,
          });
          const rebound = { ...owned, lastUsedAt: 1002 };
          expect(binding(pool.getDevice(replacement.deviceId)!)).toEqual(rebound);
          expect(manager.getDeviceForSession("owner")).toBe(replacement.deviceId);
          expect(changes.map((change) => change.binding)).toEqual([
            owned,
            { ...owned, errorCount: 1 },
            {
              ...owned,
              sessionId: null,
              status: "idle" as const,
              bindingStatus: "idle" as const,
              health: "ok" as const,
            },
            rebound,
          ]);
        } finally {
          await reservation?.release();
        }
      },
    },
    {
      // explicitDeviceBind.ts rebind + devicePool.ts releaseCapturedDevice on the old entry.
      name: "recovery rebind to another pooled device",
      run: async () => {
        await bindOwner();
        await pool.bindOrReuseDeviceSession({
          sessionId: "owner",
          deviceId: bystander.deviceId,
          platform: "android",
          allowSessionRebind: true,
        });
        expect(binding(pool.getDevice(original.deviceId)!)).toEqual({
          ...owned,
          sessionId: null,
          status: "idle" as const,
          bindingStatus: "idle" as const,
          health: "ok" as const,
        });
        expect(binding(pool.getDevice(bystander.deviceId)!)).toEqual({
          ...owned,
          lastUsedAt: 1002,
        });
      },
    },
    {
      // deviceAutolockManager.ts acquire; devicePool.ts releaseCapturedDevice on release.
      name: "autolock acquire and release",
      run: async () => {
        pool.recordDeviceError(original.deviceId);
        expect(await pool.autolockDevice(original.deviceId, "android", "client")).toBe(
          "autolock-owner",
        );
        assertAgreement();
        const locked = { ...owned, sessionId: "autolock-owner", errorCount: 1 };
        expect(binding(pool.getDevice(original.deviceId)!)).toEqual(locked);
        await manager.releaseSession("autolock-owner");
        await pool.releaseDevice(original.deviceId, "autolock-owner");
        expect(pool.getDevice(original.deviceId)?.autolockSessionId).toBeUndefined();
        expect(changes.map((change) => change.binding)).toEqual([
          locked,
          {
            ...owned,
            sessionId: null,
            status: "idle" as const,
            bindingStatus: "idle" as const,
            health: "ok" as const,
          },
        ]);
      },
    },
    {
      // adbServerResetQuarantine.ts detach before removeDevice. The removed
      // captured entry is idle, but the manager deliberately retains its session.
      name: "adb-server-reset detach",
      run: async () => {
        const captured = await bindOwner();
        pool.recordDeviceError(original.deviceId);
        const result = await pool.detachAdbServerResetCohort([captured]);
        expect(result).toEqual({ devices: [captured], deferred: false });
        expect(binding(captured)).toEqual({
          ...owned,
          sessionId: null,
          status: "idle" as const,
          bindingStatus: "idle" as const,
          health: "ok" as const,
          errorCount: 1,
        });
        expect(pool.getDevice(original.deviceId)).toBeNull();
        expect(manager.getSessionForDevice(original.deviceId)).toBe("owner");
        expect(changes.at(-1)?.binding).toEqual(binding(captured));
        await pool.releaseAdbServerResetCohortReservations(result.devices);
        await manager.releaseSession("owner", "explicit-release");
      },
    },
    {
      // missingDeviceLiveness.ts prepareEvictedDeviceForRemoval (idle).
      name: "missing-device eviction",
      run: async () => {
        pool.recordDeviceError(original.deviceId);
        utils.setBootedDevices("android", [bystander]);
        for (let miss = 0; miss < 3; miss++) {
          await pool.refreshDevices();
          assertAgreement();
        }
        expect(pool.getDevice(original.deviceId)).toBeNull();
        expect(changes).toEqual([
          {
            deviceId: original.deviceId,
            platform: "android",
            binding: { ...initial, errorCount: 1 },
          },
        ]);
      },
    },
  ];
  for (const row of rows) {
    arranged(`agreement after ${row.name}`, async () => {
      assertAgreement();
      await row.run();
      assertAgreement();
    });
  }

  arrangedEach(["add", "refresh"] as const)(
    "%s entry literal starts with no owner or history",
    async (route) => {
      // devicePool.ts addDevice and devicePoolRefresh.ts new-entry literals.
      const added = { ...original, deviceId: "emulator-5558" };
      if (route === "add") {
        await pool.addDevice(added);
      } else {
        utils.setBootedDevices("android", [original, bystander, added]);
        await pool.refreshDevices();
      }
      expect(binding(pool.getDevice(added.deviceId)!)).toEqual(initial);
      // Entry creation uses ready/incarnation notifications, not state changes.
      expect(changes).toEqual([]);
      assertAgreement();
    },
  );

  arranged(
    "tentative allocation restores every field and does not notify a rolled-back claim",
    async () => {
      // Existing bindingDirection test pins the returned device. Add only the
      // snapshot fields and silent rollback contract (devicePool.ts Object.assign).
      await bindOwner();
      pool.recordDeviceError(bystander.deviceId);
      changes.length = 0;
      expect(await pool.assignDeviceToSession("owner", "android")).toBe(original.deviceId);
      expect(binding(pool.getDevice(bystander.deviceId)!)).toEqual({ ...initial, errorCount: 1 });
      expect(changes).toEqual([]);
      assertAgreement();
    },
  );

  arrangedEach(["idle", "busy"] as const)(
    "rollback preserves raw %s binding under a health error",
    (status) => {
      const device = pool.getDevice(original.deviceId)!;
      if (status === "busy") {
        bindDevice(device, "owner");
      }
      markDeviceError(device);
      const before = binding(device);
      const snapshot = pool.testHooks.snapshotSessionAssignment(device);
      expect(snapshot).toMatchObject({ status, health: "error", sessionId: device.sessionId });
      bindDevice(device, "tentative");
      device.errorCount = 17;
      pool.testHooks.restoreSessionAssignment(device, snapshot);
      expect(binding(device)).toEqual(before);
      expect(statusOf(device)).toBe("error");
    },
  );

  arranged("stale expectedSessionId release preserves all fields and stays silent", async () => {
    // devicePool.test.ts already pins refusal; this pins the untouched tuple/event.
    await bindOwner();
    pool.recordDeviceError(original.deviceId);
    changes.length = 0;
    await pool.releaseDevice(original.deviceId, "stale-owner");
    expect(binding(pool.getDevice(original.deviceId)!)).toEqual({ ...owned, errorCount: 1 });
    expect(changes).toEqual([]);
    assertAgreement();
  });

  arranged(
    "explicit bind retains error history during detach, then resets it on the new claim",
    async () => {
      // explicitDeviceBind.ts expired/missing-owner null/idle writer. A normal
      // release leaves the pool capture for the caller's separate releaseDevice.
      await bindOwner();
      pool.recordDeviceError(original.deviceId);
      await manager.releaseSession("owner");
      changes.length = 0;
      await pool.bindOrReuseDeviceSession({
        sessionId: "next-owner",
        deviceId: original.deviceId,
        platform: "android",
      });
      const departed = {
        ...owned,
        sessionId: null,
        status: "idle" as const,
        bindingStatus: "idle" as const,
        health: "ok" as const,
        errorCount: 1,
      };
      const rebound = {
        ...owned,
        sessionId: "next-owner",
        assignmentCount: 2,
        lastUsedAt: 1002,
      };
      expect(changes.map((change) => change.binding)).toEqual([departed, rebound]);
      expect(binding(pool.getDevice(original.deviceId)!)).toEqual(rebound);
      assertAgreement();
    },
  );

  for (const bound of [false, true]) {
    arranged(
      `successful reboot clears health error only when unbound (bound ${bound})`,
      async () => {
        // recordDeviceError is a health verdict, orthogonal to ownership. addDevice
        // is the successful boot boundary; it must not clear a bound device's error.
        if (bound) {
          await bindOwner();
        }
        changes.length = 0;
        for (let error = 0; error < 5; error++) {
          pool.recordDeviceError(original.deviceId);
        }
        const failed = {
          ...(bound ? owned : initial),
          status: "error" as const,
          health: "error" as const,
          errorCount: 5,
        };
        expect(binding(pool.getDevice(original.deviceId)!)).toEqual(failed);
        expect(changes.map((change) => change.binding)).toEqual([failed]);
        assertAgreement();
        timer.advanceTime(10);
        await pool.addDevice(original, image);
        const recovered = { ...initial, lastUsedAt: 1010 };
        expect(binding(pool.getDevice(original.deviceId)!)).toEqual(bound ? failed : recovered);
        expect(changes.map((change) => change.binding)).toEqual(
          bound ? [failed] : [failed, recovered],
        );
        assertAgreement();
      },
    );
  }

  arranged(
    "preserved-session handoff detaches the pool without resetting history or reverse routing",
    async () => {
      // Only the reboot coordinator's private callback exposes this intermediate
      // writer. Invoke the instance method, retaining instance patch seams.
      const captured = await bindOwner();
      pool.recordDeviceError(original.deviceId);
      changes.length = 0;
      const session = manager.getSession("owner")!;
      expect(pool.testHooks.detachSessionForAndroidRecovery(captured, "owner", session)).toBe(true);
      const detached = {
        ...owned,
        sessionId: null,
        status: "idle" as const,
        bindingStatus: "idle" as const,
        health: "ok" as const,
        errorCount: 1,
      };
      expect(binding(captured)).toEqual(detached);
      expect(manager.getSessionForDevice(original.deviceId)).toBe("owner");
      expect(changes.map((change) => change.binding)).toEqual([detached]);
    },
  );

  arranged("preserved-session handoff refuses a superseded session object", async () => {
    const captured = await bindOwner();
    const session = manager.getSession("owner")!;
    const stale: Session = { ...session };
    changes.length = 0;
    expect(pool.testHooks.detachSessionForAndroidRecovery(captured, "owner", stale)).toBe(false);
    expect(binding(captured)).toEqual(owned);
    expect(changes).toEqual([]);
    assertAgreement();
  });

  arranged(
    "captured release refuses a stale assignment generation even with the right owner",
    async () => {
      // The public releaseDevice always captures the current generation; only
      // the instance callback can supply a stale expectedAssignmentCount.
      const captured = await bindOwner();
      pool.recordDeviceError(original.deviceId);
      changes.length = 0;
      await pool.testHooks.releaseCapturedDevice(captured, "owner", 0);
      expect(binding(captured)).toEqual({ ...owned, errorCount: 1 });
      expect(changes).toEqual([]);
      assertAgreement();
    },
  );

  arranged(
    "bound missing-device eviction clears only sessionId before the idle verdict and removal",
    async () => {
      // devicePool.ts releaseSessionForEvictedDevice :4205 is intentionally a
      // sessionId-only write; missingDeviceLiveness.ts :574 supplies idle later.
      const captured = await bindOwner();
      pool.recordDeviceError(original.deviceId);
      changes.length = 0;
      utils.setBootedDevices("android", [bystander]);
      await liveness.evictMissingPooledDevice(captured, "absent");
      const detached = { ...owned, sessionId: null, errorCount: 1 };
      const removed = {
        ...detached,
        status: "idle" as const,
        bindingStatus: "idle" as const,
        health: "ok" as const,
      };
      expect(changes.map((change) => change.binding)).toEqual([detached, removed]);
      expect(binding(captured)).toEqual(removed);
      expect(manager.getSessionForDevice(original.deviceId)).toBeNull();
      expect(pool.getDevice(original.deviceId)).toBeNull();
      assertAgreement();
    },
  );

  for (const detached of [false, true]) {
    arranged(
      `missing-device health claim notifies while unbound (detached recovery ${detached})`,
      async () => {
        // missingDeviceLiveness.ts :299 (idle eviction) / :420 (detached recovery).
        // Existing liveness tests omit the full tuple and subscriber notification.
        // Park incident I/O so both claims are observed BEFORE eviction settles.
        const captured = pool.getDevice(original.deviceId)!;
        pool.recordDeviceError(original.deviceId);
        const incidentStarted = Promise.withResolvers<void>();
        const incident = Promise.withResolvers<undefined>();
        const record = spyOn(pool, "recordEmulatorLossIncident").mockImplementation(async () => {
          incidentStarted.resolve();
          return await incident.promise;
        });
        rebootOverride = detached;
        const disconnect = spyOn(pool, "removeDisconnectedDevice").mockResolvedValue();
        utils.setBootedDevices("android", [bystander]);
        const checking = liveness.ensurePooledDevicePresent(captured, detached, false, !detached);
        try {
          await incidentStarted.promise;
          expect(binding(captured)).toEqual({
            ...initial,
            status: "error" as const,
            health: "error" as const,
            errorCount: 1,
          });
          expect(changes.map((change) => change.binding)).toEqual([
            { ...initial, status: "error", health: "error", errorCount: 1 },
          ]);
          assertAgreement();
        } finally {
          incident.resolve(undefined);
          try {
            await checking;
            await drainUntil(
              () =>
                detached
                  ? disconnect.mock.calls.length === 1
                  : pool.getDevice(original.deviceId) === null,
              { description: "missing-device eviction dispatch" },
            );
          } finally {
            record.mockRestore();
            rebootOverride = undefined;
            disconnect.mockRestore();
          }
        }
        expect(binding(captured)).toEqual({
          ...initial,
          status: detached ? "idle" : "error",
          health: detached ? "ok" : "error",
          errorCount: 1,
        });
        expect(changes).toHaveLength(detached ? 2 : 1);
      },
    );
  }
});
