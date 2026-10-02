import { afterEach, expect, test } from "bun:test";
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
  if (kind === "busy" || kind === "error") {
    device.status = kind;
  } else if (kind === "identityReconcileOwner") {
    device.identityReconcileOwner = Symbol("reconcile");
  } else {
    Reflect.set(device, kind, kind === "identityUnresolved" ? true : "owner");
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
  const deferred = Reflect.get(h.pool, "deferredDeviceReleases");
  deferred.set(h.device.deviceId, {});
  expect(h.safe()).toBe(false);
  deferred.clear();
  expect(h.safe()).toBe(true);
});

test("declines while the assignment mutex is held", async () => {
  const h = await harness();
  const release = await Reflect.get(h.pool, "assignmentMutex").acquire();
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
  const state = Reflect.get(h.pool, kind);
  if (kind === "recoveringAndroidDeviceIds") {
    state.add(h.device.deviceId);
  }
  if (kind === "recoveringAndroidImages") {
    state.set(h.device.name, { name: h.device.name, platform: "android" });
  }
  if (kind === "androidRecoveryHandoffOwners") {
    state.set(h.device.deviceId, Symbol("recovery"));
  }
  if (kind === "adbServerResetRecoveryReservations") {
    state.set(h.device.name, {
      deviceId: h.device.deviceId,
      image: { name: h.device.name, platform: "android" },
    });
  }
  if (kind === "mcpSessionRecoveryDevices") {
    state.set("client", { device: h.pool.getDevice(h.device.deviceId), token: Symbol("recovery") });
  }
  if (kind === "recoveringSessionLosses") {
    state.set("session", {
      deviceId: h.device.deviceId,
      state: "pending",
      reservations: new Set(["quarantine"]),
      sessionId: "session",
    });
  }
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
  Reflect.get(h.pool, "deviceHealthMarkers").mark(
    h.device.deviceId,
    h.pool.getDevice(h.device.deviceId)!.incarnation,
    "clock",
  );
  expect(h.safe()).toBe(false);
});
