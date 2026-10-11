import { afterEach, describe, expect, spyOn } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  DeviceShuttingDownError,
  DeviceTransportOfflineError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError, type BootedDevice } from "../../src/models";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { logger } from "../../src/utils/logger";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntil, settleByFakeEvents } from "../helpers/fakeTimerStepping";
import { warmedTests } from "../helpers/warmedTests";

const device: BootedDevice = {
  deviceId: "emulator-5560",
  name: "Pixel",
  platform: "android",
};
const image = {
  name: device.name,
  platform: "android" as const,
  isRunning: true,
  source: "local" as const,
};
let sessions: SessionManager;
afterEach(() => sessions?.stopCleanupTimer());

async function setup(pooled: boolean) {
  const timer = new FakeTimer();
  sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new FakeDeviceManager();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer,
      deviceManager: manager,
      env: { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "1" },
      installedAppsRepository: new FakeInstalledAppsRepository(),
      recoveryPolicy: { onLoss: true, maxAttempts: 1 },
    }),
  );
  if (pooled) {
    await pool.addDevice(device, image);
  }
  const entry = pool.getDevice(device.deviceId);
  const kill = spyOn(manager, "killDevice");
  const remove = spyOn(pool, "removeDevice");
  manager.androidListedDeviceStates.set(device.deviceId, "offline");
  const bind = () => pool.bindOrReuseDeviceSession("owner", device.deviceId, "android", image);
  const noLossSideEffects = () => {
    expect(kill).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(manager.startedDevices).toHaveLength(0);
  };
  const unchanged = () => {
    expect(pool.getDevice(device.deviceId)).toBe(entry);
    if (entry) {
      expect(entry).toMatchObject({ status: "idle", sessionId: null });
    }
    noLossSideEffects();
  };
  return { timer, manager, pool, entry, bind, unchanged, noLossSideEffects };
}

function track<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  return { result, settled: () => settled };
}

describe("exact Android binding during transitional adb presence", () => {
  const test = warmedTests(() => sessions?.stopCleanupTimer());

  test("own readiness reservation waits once then binds the same pooled entry", async () => {
    const h = await setup(true);
    const reservation = await h.pool.reserveDeviceForReadiness(
      device.deviceId,
      device,
      device.name,
      image.name,
    );
    try {
      const pending = track(
        h.pool.bindOrReuseDeviceSession(
          "owner",
          device.deviceId,
          "android",
          image,
          undefined,
          device,
          false,
          new Set([reservation.owner]),
        ),
      );
      await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
        description: "own-reservation bind wait",
      });
      expect(pending.settled()).toBe(false);
      h.unchanged();
      h.manager.bootedDevices = [device];
      h.manager.androidListedDeviceStates.set(device.deviceId, "device");
      h.timer.advanceTime(100);
      expect(await pending.result).toBe("owner");
      expect(h.timer.now()).toBe(100);
      expect(h.pool.getDevice(device.deviceId)).toBe(h.entry);
      expect(h.entry?.sessionId).toBe("owner");
      h.noLossSideEffects();
    } finally {
      await reservation();
    }
  });

  test("own readiness reservation retains the entry when offline outlasts the budget", async () => {
    const h = await setup(true);
    const reservation = await h.pool.reserveDeviceForReadiness(
      device.deviceId,
      device,
      device.name,
      image.name,
    );
    const entryBefore = { ...h.entry };
    try {
      const error = await settleByFakeEvents(
        h.timer,
        track(
          h.pool.bindOrReuseDeviceSession(
            "owner",
            device.deviceId,
            "android",
            image,
            undefined,
            device,
            false,
            new Set([reservation.owner]),
          ),
        ).result,
        { description: "own-reservation offline budget" },
      );
      expect(error).toBeInstanceOf(DeviceTransportOfflineError);
      expect(error).toMatchObject({
        code: "device_offline",
        retryable: true,
        deviceId: device.deviceId,
        retryAfterMs: 1000,
        state: "offline",
      });
      expect(h.timer.now()).toBe(5000);
      h.unchanged();
      expect(h.entry).toEqual(entryBefore);
    } finally {
      await reservation();
    }
  });

  test("shutdown reservation preserves the immediate refusal without probing", async () => {
    const h = await setup(true);
    const reservation = await h.pool.reserveDeviceForShutdown(device.deviceId);
    expect(reservation).toBeDefined();
    const probe = spyOn(h.manager, "getAndroidListedDeviceStates");
    try {
      const error = await settleByFakeEvents(h.timer, track(h.bind()).result, {
        description: "shutdown-reserved bind",
      });
      expect(error).toBeInstanceOf(DeviceShuttingDownError);
      expect(error).toMatchObject({
        code: "device_shutting_down",
        retryable: true,
        deviceId: device.deviceId,
        retryAfterMs: 2000,
        message: `Device '${device.deviceId}' is shutting down and cannot be assigned (code device_shutting_down); retry once the shutdown has finished.`,
      });
      expect(probe).not.toHaveBeenCalled();
      expect(h.timer.now()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      h.unchanged();
    } finally {
      probe.mockRestore();
      await reservation?.release();
    }
  });

  test("intentional shutdown marker preserves immediate absence without probing", async () => {
    const h = await setup(true);
    h.pool.markIntentionalShutdown(device.deviceId);
    const probe = spyOn(h.manager, "getAndroidListedDeviceStates");
    try {
      const error = await settleByFakeEvents(h.timer, track(h.bind()).result, {
        description: "intentionally shut down bind",
      });
      expect(error).toBeInstanceOf(ActionableError);
      expect(error).toHaveProperty(
        "message",
        `Device '${device.deviceId}' is not available in the device pool. It may have been shut down or disconnected.`,
      );
      expect(error).not.toHaveProperty("retryable");
      expect(probe).not.toHaveBeenCalled();
      expect(h.timer.now()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      h.unchanged();
    } finally {
      probe.mockRestore();
    }
  });

  test("another session's rehydration reservation still refuses after transport recovery", async () => {
    const h = await setup(true);
    await h.pool.reserveDevicesForRehydration([
      {
        sessionId: "rehydrating-owner",
        target: {
          platform: "android",
          stableDeviceId: device.name,
          deviceId: device.deviceId,
          androidEmulator: true,
        },
      },
    ]);
    h.timer.setTimeout(() => {
      h.manager.bootedDevices = [device];
      h.manager.androidListedDeviceStates.set(device.deviceId, "device");
    }, 100);
    try {
      const error = await settleByFakeEvents(h.timer, track(h.bind()).result, {
        description: "rehydration-reserved bind",
      });
      expect(error).toMatchObject({ code: "device_owned_by_other_session" });
      expect(String(error)).toContain("rehydrating-owner");
      h.unchanged();
    } finally {
      h.pool.releaseRehydrationReservation("rehydrating-owner");
    }
  });

  test("recovery readiness reservation preserves absence refusal after the transport wait", async () => {
    const h = await setup(true);
    const release = await h.pool.reserveDeviceForReadiness(
      device.deviceId,
      device,
      device.name,
      image.name,
    );
    h.timer.setTimeout(() => {
      h.manager.androidListedDeviceStates.clear();
    }, 100);
    try {
      const error = await settleByFakeEvents(h.timer, track(h.bind()).result, {
        description: "recovery-readiness bind",
      });
      expect(error).toBeInstanceOf(ActionableError);
      expect(String(error)).toContain("not available in the device pool");
      expect(error).not.toHaveProperty("retryable");
      h.unchanged();
    } finally {
      await release();
    }
  });

  test("a detached recovery reboot preserves immediate absence without probing", async () => {
    const h = await setup(true);
    h.manager.androidListedDeviceStates.clear();
    h.manager.bootedDevices = [device];
    await h.bind();
    h.manager.bootedDevices = [];
    const gate = Promise.withResolvers<void>();
    const startDevice = h.manager.startDevice.bind(h.manager);
    const start = spyOn(h.manager, "startDevice").mockImplementation(async (target) => {
      await gate.promise;
      return startDevice({ ...target, deviceId: device.deviceId });
    });
    const recovery = h.pool.recoverSessionBoundAndroidDeviceAfterLoss(
      device.deviceId,
      undefined,
      h.entry,
    );
    const probe = spyOn(h.manager, "getAndroidListedDeviceStates");
    try {
      await drainUntil(() => start.mock.calls.length > 0, {
        description: "detached recovery reboot",
      });
      expect(h.pool.getDevice(device.deviceId)).toBeNull();
      h.manager.androidListedDeviceStates.set(device.deviceId, "offline");
      probe.mockClear();
      const beforeBind = h.timer.now();
      const error = await settleByFakeEvents(h.timer, track(h.bind()).result, {
        description: "bind during detached recovery",
      });
      expect(error).toBeInstanceOf(ActionableError);
      expect(error).toHaveProperty(
        "message",
        `Device '${device.deviceId}' is not available in the device pool.`,
      );
      expect(error).not.toHaveProperty("retryable");
      expect(probe).not.toHaveBeenCalled();
      expect(h.timer.now()).toBe(beforeBind);
      expect(h.pool.getDevice(device.deviceId)).toBeNull();
    } finally {
      probe.mockRestore();
      h.manager.androidListedDeviceStates.clear();
      gate.resolve();
      await recovery;
      start.mockRestore();
    }
  });
  for (const pooled of [true, false]) {
    test(`${pooled ? "pooled" : "first boot"}: offline then online binds without replacing or restarting`, async () => {
      const h = await setup(pooled);
      const pending = track(h.bind());
      await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
        description: "bind wait",
      });
      expect(pending.settled()).toBe(false);
      h.unchanged();
      h.manager.bootedDevices = [device];
      h.manager.androidListedDeviceStates.clear();
      h.timer.advanceTime(100);
      expect(await pending.result).toBe("owner");
      if (pooled) {
        expect(h.pool.getDevice(device.deviceId)).toBe(h.entry);
      }
      expect(h.pool.getDevice(device.deviceId)?.sessionId).toBe("owner");
      h.noLossSideEffects();
    });

    test(`${pooled ? "pooled" : "first boot"}: persistent offline refuses retryably without mutation`, async () => {
      const h = await setup(pooled);
      const error = await settleByFakeEvents(h.timer, track(h.bind()).result, {
        description: "offline budget",
      });
      expect(error).toBeInstanceOf(DeviceTransportOfflineError);
      expect(error).toMatchObject({
        code: "device_offline",
        retryable: true,
        deviceId: device.deviceId,
        retryAfterMs: 1000,
        state: "offline",
      });
      expect(h.timer.now()).toBe(5000);
      h.unchanged();
    });
  }

  for (const state of [undefined, "recovery"] as const) {
    test(`real absence (${state ?? "unlisted"}) preserves the existing refusal without waiting`, async () => {
      const h = await setup(true);
      h.manager.androidListedDeviceStates.clear();
      if (state) {
        h.manager.androidListedDeviceStates.set(device.deviceId, state);
      }
      const error = await track(h.bind()).result;
      expect(error).toBeInstanceOf(ActionableError);
      expect(String(error)).toContain(
        `Device '${device.deviceId}' is not available in the device pool. It may have been shut down or disconnected.`,
      );
      expect(error).not.toHaveProperty("retryable");
      expect(h.timer.now()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      h.unchanged();
    });
  }

  test("probe failure logs and retains today's absence refusal", async () => {
    const h = await setup(true);
    const failure = new Error("adb listing failed");
    const probe = spyOn(h.manager, "getAndroidListedDeviceStates").mockRejectedValue(failure);
    const warn = spyOn(logger, "warn");
    try {
      expect(String(await track(h.bind()).result)).toContain("not available in the device pool");
      expect(warn).toHaveBeenCalledWith(expect.any(String), failure);
      expect(h.timer.now()).toBe(0);
      h.unchanged();
    } finally {
      probe.mockRestore();
      warn.mockRestore();
    }
  });

  test("request cancellation wins during the wait", async () => {
    const h = await setup(true);
    const controller = new AbortController();
    const pending = track(runWithAbortSignal(controller.signal, h.bind));
    await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
      description: "abortable bind wait",
    });
    expect(pending.settled()).toBe(false);
    const reason = new DOMException("cancel bind", "AbortError");
    controller.abort(reason);
    expect(await pending.result).toBe(reason);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    h.unchanged();
  });

  test("autolock waits for the same transport and then binds it", async () => {
    const h = await setup(true);
    const pending = track(h.pool.autolockDevice(device.deviceId, "android", "client", image));
    await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
      description: "autolock wait",
    });
    expect(pending.settled()).toBe(false);
    h.unchanged();
    h.manager.bootedDevices = [device];
    h.manager.androidListedDeviceStates.clear();
    h.timer.advanceTime(100);
    expect(await pending.result).toEqual(expect.any(String));
    expect(h.pool.getDevice(device.deviceId)).toBe(h.entry);
    expect(h.entry?.sessionId).toEqual(expect.any(String));
    h.noLossSideEffects();
  });

  test("autolock propagates the typed refusal without mutating the pool", async () => {
    const h = await setup(true);
    const error = await settleByFakeEvents(
      h.timer,
      track(h.pool.autolockDevice(device.deviceId, "android", "client", image)).result,
      { description: "autolock offline budget" },
    );
    expect(error).toBeInstanceOf(DeviceTransportOfflineError);
    expect(error).toMatchObject({
      code: "device_offline",
      retryable: true,
      deviceId: device.deviceId,
      retryAfterMs: 1000,
    });
    h.unchanged();
  });
});
