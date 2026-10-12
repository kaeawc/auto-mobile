import { expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const original: BootedDevice = {
  deviceId: "emulator-5554",
  name: "AVD-A",
  platform: "android",
  observedAt: 1,
};
const replacement = { ...original, name: "AVD-B", observedAt: 10 };
const placeholder = { ...original, name: "Unknown (emulator-5554)", observedAt: 5 };

async function setup() {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new FakeDeviceManager([], [original]);
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon-test", {
      timer,
      deviceManager: manager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
    }),
  );
  await pool.initializeWithDevices([original]);
  const entry = pool.getDevice(original.deviceId)!;
  return { timer, sessions, manager, pool, entry };
}

test("monitor settles serial reuse after sub-threshold absence and an unreadable console", async () => {
  const h = await setup();
  try {
    h.manager.bootedDevices = [];
    await h.pool.reconcileDiscoveryObservation([], "disconnect-monitor", {
      settleMembership: true,
    });
    await h.pool.reconcileDiscoveryObservation([], "disconnect-monitor", {
      settleMembership: true,
    });
    h.manager.bootedDevices = [placeholder];
    await h.pool.reconcileDiscoveryObservation([placeholder], "disconnect-monitor", {
      settleMembership: true,
    });
    expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
    h.manager.bootedDevices = [replacement];
    await h.pool.reconcileDiscoveryObservation([replacement], "disconnect-monitor", {
      settleMembership: true,
    });
    const current = h.pool.getDevice(original.deviceId)!;
    expect(current).not.toBe(h.entry);
    expect(current.incarnation).not.toBe(h.entry.incarnation);
    expect(current).toMatchObject({ name: "AVD-B", status: "idle", sessionId: null });
    expect(current.identityUnresolved).not.toBe(true);
    expect(h.manager.startedDevices).toHaveLength(0);
  } finally {
    h.sessions.stopCleanupTimer();
  }
});

test("resolved disagreement without membership opt-in only quarantines the same incarnation", async () => {
  const h = await setup();
  try {
    const incarnation = h.entry.incarnation;
    await h.pool.reconcileDiscoveryObservation([replacement], "disconnect-monitor");
    expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
    expect(h.entry.incarnation).toBe(incarnation);
    expect(h.entry).toMatchObject({ name: "AVD-A", identityUnresolved: true });
    expect(h.manager.startedDevices).toHaveLength(0);
  } finally {
    h.sessions.stopCleanupTimer();
  }
});

test("fresh settlement replaces a resolved unheld identity", async () => {
  const h = await setup();
  try {
    h.manager.bootedDevices = [replacement];
    expect(await h.pool.settlePooledRuntimeIdentity(original.deviceId)).toBe("replaced");
    const current = h.pool.getDevice(original.deviceId)!;
    expect(current).not.toBe(h.entry);
    expect(current.incarnation).not.toBe(h.entry.incarnation);
    expect(current.name).toBe("AVD-B");
    expect(current.sessionId).toBeNull();
  } finally {
    h.sessions.stopCleanupTimer();
  }
});

for (const evidence of ["placeholder", "failure", "absent"] as const) {
  test(`fresh settlement leaves ${evidence} evidence unsettled`, async () => {
    const h = await setup();
    try {
      h.manager.bootedDevices = evidence === "absent" ? [] : [placeholder];
      if (evidence === "failure") {
        h.manager.failedPlatforms.add("android");
      }
      expect(await h.pool.settlePooledRuntimeIdentity(original.deviceId)).toBe("unsettled");
      expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
      expect(h.entry.name).toBe("AVD-A");
      expect(h.entry.identityUnresolved).not.toBe(true);
    } finally {
      h.sessions.stopCleanupTimer();
    }
  });
}

test("held serial reuse retires the old session rather than assigning it the stranger", async () => {
  const h = await setup();
  try {
    await h.pool.bindOrReuseDeviceSession("holder", original.deviceId, "android");
    expect(h.sessions.getSession("holder")?.assignedDevice).toBe(original.deviceId);
    h.manager.bootedDevices = [replacement];
    expect(await h.pool.settlePooledRuntimeIdentity(original.deviceId)).toBe("replaced");
    expect(h.pool.getDevice(original.deviceId)).toMatchObject({ name: "AVD-B", sessionId: null });
    expect(h.sessions.getSession("holder")).toBeNull();
    expect(h.manager.startedDevices).toHaveLength(0);
  } finally {
    h.sessions.stopCleanupTimer();
  }
});

test("monitor leaves agreeing and older disagreeing evidence alone", async () => {
  const h = await setup();
  try {
    await h.pool.reconcileDiscoveryObservation([{ ...original, observedAt: 10 }], "test:newer");
    await h.pool.reconcileDiscoveryObservation(
      [{ ...original, observedAt: 10 }],
      "disconnect-monitor",
      {
        settleMembership: true,
      },
    );
    await h.pool.reconcileDiscoveryObservation(
      [{ ...replacement, observedAt: 9 }],
      "disconnect-monitor",
      {
        settleMembership: true,
      },
    );
    expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
    expect(h.entry).toMatchObject({ name: "AVD-A", identityObservedAt: 10 });
    expect(h.entry.identityUnresolved).not.toBe(true);
  } finally {
    h.sessions.stopCleanupTimer();
  }
});

test("fresh settlement is bounded by the request deadline without late replacement", async () => {
  const h = await setup();
  const gate =
    Promise.withResolvers<Awaited<ReturnType<FakeDeviceManager["getBootedDevicesDetailed"]>>>();
  const probe = spyOn(h.manager, "getBootedDevicesDetailed").mockImplementation(() => gate.promise);
  try {
    const pending = h.pool.settlePooledRuntimeIdentity(original.deviceId, { totalDeadlineMs: 100 });
    const refusal = pending.then(
      (value) => value,
      (error: unknown) => error,
    );
    await drainUntil(() => h.timer.getPendingTimeouts().includes(100), {
      description: "settlement deadline",
    });
    h.timer.advanceTime(100);
    expect(await refusal).toBe("unsettled");
    probe.mockRestore();
    h.manager.bootedDevices = [replacement];
    gate.resolve(await h.manager.getBootedDevicesDetailed("android"));
    await Promise.resolve();
    expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    probe.mockRestore();
    h.sessions.stopCleanupTimer();
  }
});

test("fresh settlement honours cancellation before membership changes", async () => {
  const h = await setup();
  const controller = new AbortController();
  try {
    controller.abort(new DOMException("cancel settlement", "AbortError"));
    h.manager.bootedDevices = [replacement];
    await expect(
      h.pool.settlePooledRuntimeIdentity(original.deviceId, { signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    h.sessions.stopCleanupTimer();
  }
});
