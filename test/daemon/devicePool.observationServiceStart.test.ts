import { patchDeviceBinding } from "../helpers/patchDeviceBinding";
import { recoveryInternals } from "../helpers/devicePoolRecoveryInternals";
import type { DeviceInfo } from "../../src/models";
import { markDeviceError } from "../../src/daemon/deviceBinding";
import { afterEach, expect, spyOn, test } from "bun:test";
import { observationServiceStartHarness } from "../helpers/observationServiceStartHarness";
import { drainUntil } from "../helpers/fakeTimerStepping";
import {
  ObservationReadServiceStart,
  daemonObservationServiceOwnershipGuard,
} from "../../src/features/observe/ObservationReadServiceStart";
import { DaemonState } from "../../src/daemon/daemonState";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) {
    close();
  }
});
async function harness() {
  const h = await observationServiceStartHarness();
  cleanups.push(h.close);
  return { ...h, safe: () => h.pool.isSafeForObservationServiceStart(h.device.deviceId) };
}

test("idle unowned initialized pool admits setup without changing state", async () => {
  const h = await harness();
  const before = structuredClone(h.pool.getDevice(h.device.deviceId));
  expect(h.safe()).toBe(true);
  expect(daemonObservationServiceOwnershipGuard.canStart(h.device)).toBe(true);
  expect(h.pool.getDevice(h.device.deviceId)).toEqual(before);
  expect(h.sessions.getAllSessions()).toEqual([]);
  expect(h.pool.isSafeForObservationServiceStart("missing")).toBe(false);
  DaemonState.getInstance().reset();
  expect(daemonObservationServiceOwnershipGuard.canStart(h.device)).toBe(false);
});

test.each([
  "sessionId",
  "busy",
  "error",
  "identityUnresolved",
  "identityReconcileOwner",
  "adbServerResetSessionId",
])("declines pooled %s state", async (kind) => {
  const h = await harness();
  const device = h.pool.getDevice(h.device.deviceId)!;
  if (kind === "busy" || kind === "error") {
    patchDeviceBinding(device, kind === "error" ? { health: "error" } : { status: "busy" });
  } else if (kind === "identityReconcileOwner") {
    device.identityReconcileOwner = Symbol("reconcile");
  } else if (kind === "identityUnresolved") {
    device.identityUnresolved = true;
  } else if (kind === "sessionId") {
    const writable: { sessionId: string | null } = device;
    writable.sessionId = "owner";
  } else {
    device.adbServerResetSessionId = "owner";
  }
  expect(h.safe()).toBe(false);
});

test("declines readiness reservation on the serial", async () => {
  const h = await harness();
  const release = await h.pool.reserveDeviceForReadiness(h.device.deviceId, h.device);
  try {
    expect(h.safe()).toBe(false);
  } finally {
    await release();
  }
  expect(h.safe()).toBe(true);
});

test("declines readiness reservation on the stable name of another serial", async () => {
  const h = await harness();
  const other = { ...h.device, deviceId: "emulator-other" };
  await h.pool.initializeWithDevices([h.device, other]);
  h.pool.getDevice(other.deviceId)!.avdName = other.name;
  const release = await h.pool.reserveDeviceForReadiness(other.deviceId, other);
  try {
    expect(h.safe()).toBe(false);
  } finally {
    await release();
  }
  expect(h.safe()).toBe(true);
});

test("declines shutdown reservation", async () => {
  const h = await harness();
  const reservation = await h.pool.reserveDeviceForShutdown(h.device.deviceId);
  try {
    expect(h.safe()).toBe(false);
  } finally {
    await reservation?.release();
  }
  expect(h.safe()).toBe(true);
});

test("declines pending cleanup and a deferred release even if pooled state says idle", async () => {
  const h = await harness();
  const pending = Promise.withResolvers<void>();
  h.sessions.registerPendingDeviceCleanup(h.device.deviceId, pending.promise);
  expect(h.safe()).toBe(false);
  pending.resolve();
  await h.sessions.getPendingDeviceCleanup(h.device.deviceId);
  expect(h.safe()).toBe(true);
  const deferred = h.pool.testHooks.deferredDeviceReleases;
  deferred.set(h.device.deviceId, {
    device: h.pool.getDevice(h.device.deviceId)!,
    sessionId: "session",
    assignmentCount: 1,
    cleanup: Promise.resolve(),
  });
  expect(h.safe()).toBe(false);
  deferred.clear();
  expect(h.safe()).toBe(true);
});

test("declines while the assignment mutex is held", async () => {
  const h = await harness();
  const release = await h.pool.testHooks.assignmentMutex.acquire();
  try {
    expect(h.safe()).toBe(false);
  } finally {
    release();
  }
  expect(h.safe()).toBe(true);
});

test.each(["stable", "selector"] as const)("declines %s lifecycle lease", async (kind) => {
  const h = await harness();
  const identity =
    kind === "stable"
      ? { kind, platform: h.device.platform, stableId: h.device.name }
      : { kind, platform: h.device.platform, selector: h.device.name };
  const lease = await h.lifecycle.reserve(identity, { operation: "start", deadlineMs: 100 });
  try {
    expect(h.safe()).toBe(false);
  } finally {
    lease.release();
  }
  expect(h.safe()).toBe(true);
});

test.each([false, true])(
  "declines Android startup lease (offline recovery: %s)",
  async (ownsOfflineRecovery) => {
    const h = await harness();
    const release = await h.pool.reserveAndroidStartupLease(
      h.device.name,
      true,
      undefined,
      ownsOfflineRecovery,
    );
    try {
      expect(h.safe()).toBe(false);
    } finally {
      await release();
    }
    expect(h.safe()).toBe(true);
  },
);

const image = (name: string): DeviceInfo => ({ name, platform: "android", isRunning: false });

type RecoveryTransition = {
  seed(h: Awaited<ReturnType<typeof harness>>): () => void;
};

const RECOVERY_TRANSITIONS: Record<string, RecoveryTransition> = {
  recoveringAndroidDeviceIds: {
    seed: (h) => {
      const state = recoveryInternals(h.pool).recoveringAndroidDeviceIds;
      state.add(h.device.deviceId);
      return () => state.clear();
    },
  },
  recoveringAndroidImages: {
    seed: (h) => {
      const state = recoveryInternals(h.pool).recoveringAndroidImages;
      state.set(h.device.name, image(h.device.name));
      return () => state.clear();
    },
  },
  androidRecoveryHandoffOwners: {
    seed: (h) => {
      const state = recoveryInternals(h.pool).androidRecoveryHandoffOwners;
      state.set(h.device.deviceId, Symbol("recovery"));
      return () => state.clear();
    },
  },
  adbServerResetRecoveryReservations: {
    seed: (h) => {
      const state = h.pool.testHooks.adbServerResetRecoveryReservations;
      state.set(h.device.name, {
        deviceId: h.device.deviceId,
        image: image(h.device.name),
        cancelled: false,
        settled: Promise.resolve(),
        resolve: () => {},
      });
      return () => state.clear();
    },
  },
  mcpSessionRecoveryDevices: {
    seed: (h) => {
      const state = h.pool.testHooks.mcpSessionRecoveryDevices;
      state.set("client", {
        device: h.pool.getDevice(h.device.deviceId)!,
        token: Symbol("recovery"),
      });
      return () => state.clear();
    },
  },
  recoveringSessionLosses: {
    seed: (h) => {
      const state = recoveryInternals(h.pool).recoveringSessionLosses;
      state.set("session", {
        deviceId: h.device.deviceId,
        state: "pending",
        reservations: new Set(["quarantine"]),
        sessionId: "session",
        generation: 1,
        deferredShutdowns: 0,
      });
      return () => state.clear();
    },
  },
};

test.each(Object.keys(RECOVERY_TRANSITIONS))("declines %s transition", async (kind) => {
  const h = await harness();
  const clear = RECOVERY_TRANSITIONS[kind]!.seed(h);
  expect(h.safe()).toBe(false);
  clear();
  expect(h.safe()).toBe(true);
});

test("declines a reverse session assignment not yet published in the pooled entry", async () => {
  const h = await harness();
  await h.sessions.createSession("assigning-owner", h.device.deviceId, "android");
  expect(h.pool.getDevice(h.device.deviceId)?.sessionId).toBeNull();
  expect(h.safe()).toBe(false);
});

test("declines an unresolved restoration health marker", async () => {
  const h = await harness();
  h.pool.testHooks.deviceHealthMarkers.mark(
    h.device.deviceId,
    h.pool.getDevice(h.device.deviceId)!.incarnation,
    "clock",
  );
  expect(h.safe()).toBe(false);
});

test("allocation and inventory do not collect observation recovery facts", async () => {
  const h = await harness();
  const recovery = spyOn(h.pool, "getRecoveringAndroidTargets").mockImplementation(() => {
    throw new Error("Observation-only recovery probe reached by allocation/inventory");
  });
  try {
    expect(h.pool.genericAvailability(h.device.deviceId)).toBe("free");
    expect(h.pool.poolBucket(h.device.deviceId)).toBe("idle");
    expect(h.pool.getIdleDevices()).toHaveLength(1);
    expect(h.pool.getStats().idle).toBe(1);
    expect(recovery).not.toHaveBeenCalled();
  } finally {
    recovery.mockRestore();
  }
});

test("observation declines bound/busy/error rows before collecting recovery facts", async () => {
  const h = await harness();
  const recovery = spyOn(h.pool, "getRecoveringAndroidTargets");
  try {
    const device = h.pool.getDevice(h.device.deviceId)!;
    expect(h.pool.isSafeForObservationServiceStart("missing")).toBe(false);
    const writable: { sessionId: string | null } = device;
    writable.sessionId = "owner";
    expect(h.safe()).toBe(false);
    patchDeviceBinding(device, { sessionId: null });
    patchDeviceBinding(device, { status: "busy" });
    expect(h.safe()).toBe(false);
    markDeviceError(device);
    expect(h.safe()).toBe(false);
    expect(recovery).not.toHaveBeenCalled();
  } finally {
    recovery.mockRestore();
  }
});

test("observation still evaluates later blockers through the live instance after readiness blocks", async () => {
  const h = await harness();
  const release = await h.pool.reserveDeviceForReadiness(h.device.deviceId, h.device);
  const recovery = spyOn(h.pool, "getRecoveringAndroidTargets").mockReturnValue({
    names: new Set(),
    serials: new Set(),
  });
  const reverse = spyOn(h.sessions, "getSessionForDevice");
  const health = spyOn(h.pool, "getDeviceHealthMarker");
  const lifecycle = spyOn(h.lifecycle, "isReserved");
  try {
    expect(h.safe()).toBe(false);
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(reverse).toHaveBeenCalledWith(h.device.deviceId);
    expect(health).toHaveBeenCalledWith(h.device.deviceId);
    expect(lifecycle).toHaveBeenCalledTimes(2);
  } finally {
    lifecycle.mockRestore();
    health.mockRestore();
    reverse.mockRestore();
    recovery.mockRestore();
    await release();
  }
});

test("assignment transition returns false when free and waits for release when held", async () => {
  const h = await harness();
  expect(await h.pool.waitForAssignmentTransition(h.device.deviceId)).toBe(false);
  const release = await h.pool.testHooks.assignmentMutex.acquire();
  let settled = false;
  const pending = h.pool.waitForAssignmentTransition(h.device.deviceId).then((result) => {
    settled = true;
    return result;
  });
  try {
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    release();
  }
  expect(await pending).toBe(true);
});

test("assignment transition preserves abort reason", async () => {
  const h = await harness();
  const release = await h.pool.testHooks.assignmentMutex.acquire();
  const controller = new AbortController();
  const reason = new Error("stop waiting");
  try {
    const pending = h.pool.waitForAssignmentTransition(h.device.deviceId, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  } finally {
    release();
  }
});

test("real daemon guard waits for the post-pickup assignment transition", async () => {
  const h = await harness();
  let pooled = false;
  let release: (() => void) | undefined;
  let waiting = false;
  let readiness = 0;
  const original = h.pool.waitForAssignmentTransition.bind(h.pool);
  const wait = spyOn(h.pool, "waitForAssignmentTransition").mockImplementation(
    (deviceId, signal) => {
      waiting = true;
      return original(deviceId, signal);
    },
  );
  const starter = new ObservationReadServiceStart({
    timer: h.timer,
    ownershipGuard: {
      canStart: (device) => pooled && daemonObservationServiceOwnershipGuard.canStart(device),
      awaitTransition: (device, signal) =>
        daemonObservationServiceOwnershipGuard.awaitTransition!(device, signal),
    },
    poolPickup: {
      available: () => true,
      isPooled: () => pooled,
      ensurePooled: async () => {
        pooled = true;
        release = await h.pool.testHooks.assignmentMutex.acquire();
      },
    },
    readiness: {
      ensureReady: async (request) => {
        request.assertCanSetup?.();
        readiness++;
      },
    },
    isServiceConnected: () => false,
  });
  try {
    const pending = starter.start({ device: h.device, deadlineMs: h.timer.now() + 100 });
    void pending.catch(() => {});
    await drainUntil(() => waiting, { description: "real pool transition" });
    expect(readiness).toBe(0);
    release!();
    release = undefined;
    expect(await pending).toBe(true);
    expect(readiness).toBe(1);
  } finally {
    release?.();
    wait.mockRestore();
  }
});

// A resolved waiter makes accidental waits fail deterministically without parking the test.
for (const consumer of ["pool", "start"] as const) {
  test.each(["bound", "busy", "readiness", "recovery", "unpooled"] as const)(
    `${consumer} never waits for %s device`,
    async (kind) => {
      const h = await harness();
      const device = h.pool.getDevice(h.device.deviceId)!;
      let releaseReservation: (() => Promise<void>) | undefined;
      if (kind === "bound") {
        patchDeviceBinding(device, { sessionId: "owner" });
      } else if (kind === "busy") {
        patchDeviceBinding(device, { status: "busy" });
      } else if (kind === "readiness") {
        releaseReservation = await h.pool.reserveDeviceForReadiness(h.device.deviceId, h.device);
      } else if (kind === "recovery") {
        recoveryInternals(h.pool).recoveringAndroidDeviceIds.add(h.device.deviceId);
      }
      const target = kind === "unpooled" ? { ...h.device, deviceId: "missing" } : h.device;
      const release = await h.pool.testHooks.assignmentMutex.acquire();
      const wait = spyOn(h.pool.testHooks.assignmentMutex, "waitForUnlock").mockResolvedValue();
      let readiness = 0;
      const starter = new ObservationReadServiceStart({
        timer: h.timer,
        ownershipGuard: daemonObservationServiceOwnershipGuard,
        poolPickup: {
          available: () => false,
          isPooled: () => kind !== "unpooled",
          ensurePooled: async () => {},
        },
        readiness: {
          ensureReady: async () => {
            readiness++;
          },
        },
        isServiceConnected: () => false,
      });
      try {
        if (consumer === "pool") {
          expect(await h.pool.waitForAssignmentTransition(target.deviceId)).toBe(false);
        } else {
          await expect(starter.start({ device: target, deadlineMs: 100 })).rejects.toThrow(
            "service start declined: ownership or pool transition cannot be excluded",
          );
        }
        expect(wait).not.toHaveBeenCalled();
        expect(readiness).toBe(0);
        expect(h.timer.now()).toBe(0);
        expect(h.timer.getSleepCallCount()).toBe(0);
        expect(h.timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        wait.mockRestore();
        release();
        await releaseReservation?.();
      }
    },
  );
}
