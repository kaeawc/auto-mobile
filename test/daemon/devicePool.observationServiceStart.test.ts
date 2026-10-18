import { recoveryInternals } from "../helpers/devicePoolRecoveryInternals";
import { markDeviceError, restoreBinding } from "../../src/daemon/deviceBinding";
import { afterEach, expect, spyOn, test } from "bun:test";
import { observationServiceStartHarness } from "../helpers/observationServiceStartHarness";
import { daemonObservationServiceOwnershipGuard } from "../../src/features/observe/ObservationReadServiceStart";
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
  if (kind === "busy") {
    restoreBinding(device, { sessionId: null, status: "busy" });
  } else if (kind === "error") {
    markDeviceError(device);
  } else if (kind === "sessionId") {
    restoreBinding(device, { sessionId: "owner", status: "idle" });
  } else if (kind === "identityReconcileOwner") {
    device.identityReconcileOwner = Symbol("reconcile");
  } else if (kind === "identityUnresolved") {
    device.identityUnresolved = true;
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
    sessionId: "deferred",
    assignmentCount: 0,
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

test.each([
  "recoveringAndroidDeviceIds",
  "recoveringAndroidImages",
  "androidRecoveryHandoffOwners",
  "adbServerResetRecoveryReservations",
  "mcpSessionRecoveryDevices",
  "recoveringSessionLosses",
])("declines %s transition", async (kind) => {
  const h = await harness();
  const { deviceId, name } = h.device;
  const recovery = recoveryInternals(h.pool);
  const hooks = h.pool.testHooks;
  const image = { name, platform: "android" as const, isRunning: false };
  const seeds = {
    recoveringAndroidDeviceIds: () => ({
      clear: () => recovery.recoveringAndroidDeviceIds.clear(),
      seed: () => recovery.recoveringAndroidDeviceIds.add(deviceId),
    }),
    recoveringAndroidImages: () => ({
      clear: () => recovery.recoveringAndroidImages.clear(),
      seed: () => recovery.recoveringAndroidImages.set(name, image),
    }),
    androidRecoveryHandoffOwners: () => ({
      clear: () => recovery.androidRecoveryHandoffOwners.clear(),
      seed: () => recovery.androidRecoveryHandoffOwners.set(deviceId, Symbol("recovery")),
    }),
    adbServerResetRecoveryReservations: () => ({
      clear: () => hooks.adbServerResetRecoveryReservations.clear(),
      seed: () =>
        hooks.adbServerResetRecoveryReservations.set(name, {
          deviceId,
          image,
          cancelled: false,
          settled: Promise.resolve(),
          resolve: () => undefined,
        }),
    }),
    mcpSessionRecoveryDevices: () => ({
      clear: () => hooks.mcpSessionRecoveryDevices.clear(),
      seed: () =>
        hooks.mcpSessionRecoveryDevices.set("client", {
          device: h.pool.getDevice(deviceId)!,
          token: Symbol("recovery"),
        }),
    }),
    recoveringSessionLosses: () => ({
      clear: () => recovery.recoveringSessionLosses.clear(),
      seed: () => hooks.startAndroidRecoveryRecord("session", { deviceId }, ["quarantine"]),
    }),
  };
  const state = seeds[kind]();
  state.seed();
  expect(h.safe()).toBe(false);
  state.clear();
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
    device.sessionId = "owner";
    expect(h.safe()).toBe(false);
    device.sessionId = null;
    device.status = "busy";
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
