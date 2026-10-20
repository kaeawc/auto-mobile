import { makePool } from "../helpers/makePool";
import { markDeviceError } from "../../src/daemon/deviceBinding";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import type { BindingExclusion } from "../../src/daemon/sessionBroker/provisioning/exclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { AndroidTransportAliases } from "../../src/utils/androidSerial";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import type { MutablePooledDevice } from "./helpers/DaemonDisconnectHarness";

interface Answers {
  availability: ReturnType<DevicePool["genericAvailability"]>;
  bucket: ReturnType<DevicePool["poolBucket"]>;
  observation: boolean;
  healthRecovery: boolean;
  idleAllocation: boolean;
}

interface HoldRow {
  name: string;
  setup: () => void | Promise<void>;
  expected: Answers;
  recoveryRequester?: string;
}

// Reuses the injected construction in devicePool.statsBuckets.test.ts and the lifecycle/
// persistence seams in observationServiceStartHarness; no daemon, device I/O or file DB.
describe("device hold current-behavior characterization (#11803)", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let pool: DevicePool;
  let markers: InMemoryDeviceHealthMarkers;
  let brokerHeld: boolean;
  let lifecycle: InMemoryVirtualDeviceLifecycleCoordinator;
  let booted: BootedDevice;
  let canRecover: (deviceId: string) => boolean;
  let foreignOwner: number | undefined;
  let cleanups: Array<() => void | Promise<void>>;

  async function initializePool() {
    timer = new FakeTimer();
    cleanups = [];
    foreignOwner = undefined;
    booted = { deviceId: "emulator-8621", name: "Read device", platform: "android" };
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    markers = new InMemoryDeviceHealthMarkers(timer);
    brokerHeld = false;
    const bindings: BindingExclusion = {
      refresh: async () => {},
      holderOf: ({ stableIds }) =>
        brokerHeld && stableIds.includes(booted.deviceId)
          ? {
              platform: booted.platform,
              stableDeviceId: booted.deviceId,
              holder: "session_broker",
              scopeKey: "scope",
              bindingIndex: 0,
              scopeState: null,
              execSessionUuid: "binding-exec",
            }
          : undefined,
      stableIdsFor: () => new Set(brokerHeld ? [booted.deviceId] : []),
    };
    lifecycle = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices(booted.platform, [booted]);
    const ownership: ForeignDeviceOwnership = {
      refresh: async () => {},
      foreignOwnerPid: () => foreignOwner,
      claim: async () => true,
      release: () => {},
    };
    // Observe the actual predicate installed by wireSessionDeviceHealth, not a copy of it.
    const wiring = spyOn(sessions, "setDeviceHealthMarkers");
    try {
      pool = makePool(sessions, "hold-characterization", {
        timer,
        deviceManager: manager,
        deviceHealthMarkers: markers,
        bindingExclusion: bindings,
        foreignDeviceOwnership: ownership,
        lifecycleCoordinator: lifecycle,
        deviceSessionContinuityEnabled: true,
      });
      expect(wiring).toHaveBeenCalledTimes(1);
      canRecover = wiring.mock.calls[0]![2];
    } finally {
      wiring.mockRestore();
    }
    await pool.initializeWithDevices([booted]);
  }

  async function closePool() {
    try {
      for (const cleanup of cleanups.reverse()) {
        await cleanup();
      }
    } finally {
      sessions.stopCleanupTimer();
      timer.reset();
    }
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arrangedEach<T>(table: readonly T[]) {
    return (name: string, fn: (row: T) => void | Promise<void>, timeout?: number): void => {
      test.each<T>([...table])(
        name,
        async (row: T) => {
          await initializePool();
          await fn(row);
        },
        timeout,
      );
    };
  }
  afterEach(closePool);
  // Warm the allocation module path outside the per-test budget, as warmedTests does.
  // Every measured row still constructs a fresh pool and asserts literal current answers.
  beforeAll(async () => {
    await initializePool();
    try {
      await pool.assignDeviceToSession("warm-allocation", booted.platform);
    } finally {
      await closePool();
    }
  });

  const entry = (): MutablePooledDevice => pool.getDevice(booted.deviceId)!;
  const rehydration = async () => {
    await pool.reserveDevicesForRehydration([
      {
        sessionId: "row-owner",
        target: {
          platform: booted.platform,
          deviceId: booted.deviceId,
          stableDeviceId: booted.name,
          androidEmulator: true,
        },
      },
    ]);
    cleanups.push(() => pool.releaseRehydrationReservation("row-owner"));
  };

  // Columns are literal answers, deliberately not calculated from one common hold predicate.
  // isReservedForAssignment is exercised via genericAvailability and poolBucket; the
  // session-relative branch is additionally exercised by assignDeviceToSession below.
  const rows: HoldRow[] = [
    {
      name: "free idle device",
      setup: () => {},
      expected: {
        availability: "free",
        bucket: "idle",
        observation: true,
        healthRecovery: true,
        idleAllocation: true,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; a sessionId alone does not reserve or bucket the row.
    {
      name: "bound sessionId with idle status",
      setup: () => {
        entry().sessionId = "owner";
      },
      expected: {
        availability: "free",
        bucket: "idle",
        observation: false,
        healthRecovery: false,
        idleAllocation: true,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; generic availability ignores busy status.
    {
      name: "busy status without a session",
      setup: () => {
        entry().status = "busy";
      },
      expected: {
        availability: "free",
        bucket: "assigned",
        observation: false,
        healthRecovery: false,
        idleAllocation: false,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; generic availability ignores error status.
    {
      name: "error status",
      setup: () => {
        markDeviceError(entry());
      },
      expected: {
        availability: "free",
        bucket: "error",
        observation: false,
        healthRecovery: false,
        idleAllocation: false,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; health recovery ignores readiness reservations.
    {
      name: "readiness reservation by id",
      setup: async () => {
        cleanups.push(await pool.reserveDeviceForReadiness(booted.deviceId, booted));
      },
      expected: {
        availability: "reserved",
        bucket: "assigned",
        observation: false,
        healthRecovery: true,
        idleAllocation: false,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; another serial's stable-name reservation blocks allocation.
    {
      name: "readiness reservation by name on another serial",
      setup: async () => {
        const other = { ...booted, deviceId: "emulator-8623" };
        await pool.initializeWithDevices([booted, other]);
        pool.getDevice(other.deviceId)!.avdName = other.name;
        cleanups.push(await pool.reserveDeviceForReadiness(other.deviceId, other));
      },
      expected: {
        availability: "reserved",
        bucket: "assigned",
        observation: false,
        healthRecovery: true,
        idleAllocation: false,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; health recovery ignores shutdown reservations.
    {
      name: "shutdown reservation",
      setup: async () => {
        const reservation = await pool.reserveDeviceForShutdown(booted.deviceId);
        expect(reservation).toBeDefined();
        cleanups.push(() => reservation!.release());
      },
      expected: {
        availability: "reserved",
        bucket: "assigned",
        observation: false,
        healthRecovery: true,
        idleAllocation: false,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; health recovery ignores rehydration reservations.
    {
      name: "rehydration reservation for its own row",
      setup: rehydration,
      recoveryRequester: "row-owner",
      expected: {
        availability: "reserved",
        bucket: "assigned",
        observation: false,
        healthRecovery: true,
        idleAllocation: false,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; another session cannot bypass the row's reservation.
    {
      name: "rehydration reservation for another row",
      setup: rehydration,
      recoveryRequester: "row-other",
      expected: {
        availability: "reserved",
        bucket: "assigned",
        observation: false,
        healthRecovery: true,
        idleAllocation: false,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; unhealthy idle is free generically, assigned in inventory.
    {
      name: "health-marked idle device",
      setup: () => {
        markers.mark(booted.deviceId, pool.getDeviceIncarnation(booted.deviceId)!, "app-cleanup");
      },
      expected: {
        availability: "free",
        bucket: "assigned",
        observation: false,
        healthRecovery: true,
        idleAllocation: false,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; observation and health recovery ignore broker-binding holds.
    {
      name: "broker-binding holder",
      setup: async () => {
        brokerHeld = true;
      },
      expected: {
        availability: "session_broker",
        bucket: "assigned",
        observation: true,
        healthRecovery: true,
        idleAllocation: false,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; observation and health recovery ignore foreign claims.
    {
      name: "foreign daemon holder",
      setup: () => {
        foreignOwner = 42;
      },
      expected: {
        availability: "foreign_daemon",
        bucket: "assigned",
        observation: true,
        healthRecovery: true,
        idleAllocation: false,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; only observation rejects unresolved identity here.
    {
      name: "identityUnresolved",
      setup: () => {
        entry().identityUnresolved = true;
      },
      expected: {
        availability: "free",
        bucket: "idle",
        observation: false,
        healthRecovery: true,
        idleAllocation: true,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; only observation rejects an identity reconciliation owner.
    {
      name: "identityReconcileOwner",
      setup: () => {
        entry().identityReconcileOwner = Symbol("reconcile");
      },
      expected: {
        availability: "free",
        bucket: "idle",
        observation: false,
        healthRecovery: true,
        idleAllocation: true,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; only observation rejects the ADB reset session marker.
    {
      name: "adbServerResetSessionId",
      setup: () => {
        entry().adbServerResetSessionId = "reset-owner";
      },
      expected: {
        availability: "free",
        bucket: "idle",
        observation: false,
        healthRecovery: true,
        idleAllocation: true,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; allocation/inventory do not inspect pending cleanup.
    {
      name: "cleanup in progress",
      setup: () => {
        const pending = Promise.withResolvers<void>();
        sessions.registerPendingDeviceCleanup(booted.deviceId, pending.promise);
        expect(sessions.hasDeviceCleanupInProgress(booted.deviceId)).toBe(true);
        cleanups.push(async () => {
          pending.resolve();
          await sessions.getPendingDeviceCleanup(booted.deviceId);
        });
      },
      expected: {
        availability: "free",
        bucket: "idle",
        observation: false,
        healthRecovery: false,
        idleAllocation: true,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; isolate the deferred fence from session/cleanup guards.
    {
      name: "deferred release with idle unbound pooled state",
      setup: async () => {
        const pending = Promise.withResolvers<void>();
        entry().sessionId = "releasing";
        const cleanup = spyOn(sessions, "getPendingDeviceCleanup").mockReturnValueOnce(
          pending.promise,
        );
        try {
          await pool.releaseDevice(booted.deviceId, "releasing");
          expect(cleanup).toHaveBeenCalled();
        } finally {
          cleanup.mockRestore();
        }
        // The public mutable entry lets us isolate the retained fence, as in observation tests.
        entry().sessionId = null;
        entry().status = "idle";
        expect(sessions.hasDeviceCleanupInProgress(booted.deviceId)).toBe(false);
        cleanups.push(async () => {
          pending.resolve();
          await pending.promise;
          expect(pool.isSafeForObservationServiceStart(booted.deviceId)).toBe(true);
        });
      },
      expected: {
        availability: "free",
        bucket: "idle",
        observation: false,
        healthRecovery: true,
        idleAllocation: true,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; only observation sees a pending session-loss record.
    {
      name: "recoveringSessionLosses preparation with idle unbound pooled state",
      setup: async () => {
        await sessions.createSession("recovering", booted.deviceId, booted.platform);
        entry().sessionId = "recovering";
        const preparation = pool.prepareSessionPreservingRecovery(booted.deviceId);
        expect(preparation).toBeDefined();
        // Isolate the record from the separate pooled and reverse session-binding guards.
        entry().sessionId = null;
        const reverse = spyOn(sessions, "getSessionForDevice").mockReturnValue(null);
        cleanups.push(() => {
          try {
            pool.finishSessionPreservingRecoveryPreparation(preparation);
            expect(pool.isSafeForObservationServiceStart(booted.deviceId)).toBe(true);
          } finally {
            reverse.mockRestore();
          }
        });
        expect(pool.getRecoveringAndroidTargets().serials.has(booted.deviceId)).toBe(true);
      },
      expected: {
        availability: "free",
        bucket: "idle",
        observation: false,
        healthRecovery: true,
        idleAllocation: true,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; only observation sees an offline-recovery startup lease.
    {
      name: "Android offline-recovery startup lease",
      setup: async () => {
        cleanups.push(await pool.reserveAndroidStartupLease(booted.name, true, undefined, true));
      },
      expected: {
        availability: "free",
        bucket: "idle",
        observation: false,
        healthRecovery: true,
        idleAllocation: true,
      },
    },
    // CURRENT-BEHAVIOR PIN: sites disagree; observation and health recovery ignore alias assignability.
    {
      name: "Android transport alias becomes unassignable",
      setup: () => {
        const routing = pool.getAndroidTransportRouting();
        if (!(routing instanceof AndroidTransportAliases)) {
          throw new Error("Expected the pool's Android alias routing seam");
        }
        const alias = { ...booted, deviceId: "phone:5555" };
        // A peer proves this physical serial while the pooled row has no identity evidence.
        routing.fold(
          [booted, alias],
          new Map([[alias.deviceId, { key: "phone", physicalSerial: booted.deviceId }]]),
          new Set([booted.deviceId]),
        );
        expect(pool.isAndroidTransportAssignable(booted)).toBe(false);
      },
      expected: {
        availability: "free",
        bucket: "assigned",
        observation: true,
        healthRecovery: true,
        idleAllocation: false,
      },
    },
  ];

  arrangedEach(rows)("$name", async ({ setup, expected, recoveryRequester }: HoldRow) => {
    await setup();
    expect({
      availability: pool.genericAvailability(booted.deviceId),
      bucket: pool.poolBucket(booted.deviceId),
      observation: pool.isSafeForObservationServiceStart(booted.deviceId),
      healthRecovery: canRecover(booted.deviceId),
      idleAllocation: pool.getIdleDevices().some((device) => device.id === booted.deviceId),
    }).toEqual(expected);

    if (recoveryRequester) {
      // Run after the read-only columns: a successful own-row assignment changes pool state.
      const assignment = runWithAbortSignal(new AbortController().signal, () =>
        pool.assignDeviceToSession(recoveryRequester, booted.platform, {
          platform: booted.platform,
          deviceId: booted.deviceId,
          stableDeviceId: booted.name,
          androidEmulator: true,
        }),
      );
      if (recoveryRequester === "row-owner") {
        await expect(assignment).resolves.toBe(booted.deviceId);
      } else {
        await expect(assignment).rejects.toThrow("target-busy");
      }
    }
  });
});
