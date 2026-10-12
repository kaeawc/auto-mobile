import { afterEach, describe, expect, spyOn } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  DeviceShuttingDownError,
  DeviceTransportOfflineError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { SessionManager } from "../../src/daemon/sessionManager";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
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
  return { timer, manager, pool, entry, bind, unchanged, noLossSideEffects, kill, remove };
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

  for (const state of [undefined, "device"] as const) {
    test(`adopted emulator re-discovers an absent snapshot with probe ${state ?? "unlisted"}`, async () => {
      const h = await setup(true);
      h.manager.androidListedDeviceStates.clear();
      if (state) {
        h.manager.androidListedDeviceStates.set(device.deviceId, state);
      }
      const pending = track(
        h.pool.bindOrReuseDeviceSession(
          "owner",
          device.deviceId,
          "android",
          image,
          undefined,
          device,
        ),
      );
      await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
        description: "adopted transport wait",
      });
      expect(pending.settled()).toBe(false);
      h.unchanged();
      h.manager.bootedDevices = [device];
      h.manager.androidListedDeviceStates.set(device.deviceId, "device");
      h.timer.advanceTime(100);
      expect(await pending.result).toBe("owner");
      expect(h.timer.now()).toBe(100);
      expect(h.pool.getDevice(device.deviceId)).toBe(h.entry);
      h.noLossSideEffects();
    });
  }

  test("autolock adopts a resolved idle emulator when its absent transport returns", async () => {
    const h = await setup(true);
    h.manager.androidListedDeviceStates.clear();
    const discovery = spyOn(h.manager, "getBootedDevicesDetailed");
    try {
      const pending = track(
        h.pool.autolockDevice(device.deviceId, "android", "client", image, undefined, device),
      );
      await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
        description: "autolock adopted transport wait",
      });
      expect(pending.settled()).toBe(false);
      expect(discovery).toHaveBeenCalledTimes(1);
      expect((await discovery.mock.results[0]!.value).devices).toEqual([]);
      h.unchanged();
      h.manager.bootedDevices = [device];
      h.manager.androidListedDeviceStates.set(device.deviceId, "device");
      h.timer.advanceTime(100);
      const sessionId = await pending.result;
      expect(sessionId).toEqual(expect.any(String));
      expect(discovery).toHaveBeenCalledTimes(2);
      expect((await discovery.mock.results[1]!.value).devices).toEqual([device]);
      expect(h.timer.now()).toBe(100);
      expect(h.pool.getDevice(device.deviceId)).toBe(h.entry);
      expect(h.entry?.sessionId).toBe(sessionId);
      h.noLossSideEffects();
    } finally {
      discovery.mockRestore();
      sessions.stopCleanupTimer();
    }
  });

  test("adopted emulator whose transport never returns refuses retryably within budget", async () => {
    const h = await setup(true);
    h.manager.androidListedDeviceStates.clear();
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
        ),
      ).result,
      { description: "adopted transport budget" },
    );
    expect(error).toBeInstanceOf(DeviceTransportOfflineError);
    expect(error).toMatchObject({
      code: "device_offline",
      retryable: true,
      retryAfterMs: 1000,
      state: undefined,
    });
    expect(String(error)).toContain(
      `adb did not list the previously resolved emulator '${device.deviceId}' steadily while binding (its transport was absent or flapping)`,
    );
    expect(String(error)).not.toContain("this request started");
    expect(h.timer.now()).toBe(5000);
    h.unchanged();
  });

  for (const autolock of [false, true]) {
    test(`${autolock ? "autolock" : "explicit bind"}: live first-boot process holds offline then absent transport until the same serial returns`, async () => {
      const h = await setup(true);
      const child = new FakeChildProcess(h.timer);
      const process = child as unknown as ChildProcess;
      h.manager.bootedDevices = [device];
      h.manager.androidListedDeviceStates.set(device.deviceId, "device");
      expect(await h.manager.getBootedDevices("android")).toEqual([device]);
      h.manager.bootedDevices = [];
      h.manager.androidListedDeviceStates.set(device.deviceId, "offline");
      const pending = track(
        autolock
          ? h.pool.autolockDevice(device.deviceId, "android", "client", image, process)
          : h.pool.bindOrReuseDeviceSession("owner", device.deviceId, "android", image, process),
      );
      await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
        description: "first-boot offline wait",
      });
      expect(pending.settled()).toBe(false);
      h.manager.androidListedDeviceStates.clear();
      h.timer.advanceTime(100);
      await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(200), {
        description: "first-boot absent wait",
      });
      expect(pending.settled()).toBe(false);
      h.manager.bootedDevices = [device];
      h.manager.androidListedDeviceStates.set(device.deviceId, "device");
      h.timer.advanceTime(200);
      expect(await pending.result).toEqual(autolock ? expect.any(String) : "owner");
      expect(h.pool.getDevice(device.deviceId)).toBe(h.entry);
      expect(child.killed).toBe(false);
      h.noLossSideEffects();
    });
  }

  for (const live of [true, false]) {
    test(`stale listing with ${live ? "live" : "no"} launch and device probe ${live ? "re-discovers the same serial" : "preserves absence"}`, async () => {
      const h = await setup(true);
      const child = new FakeChildProcess(h.timer);
      h.manager.androidListedDeviceStates.clear();
      const probe = spyOn(h.manager, "getAndroidListedDeviceStates").mockResolvedValue(
        new Map([[device.deviceId, "device"]]),
      );
      try {
        const pending = track(
          h.pool.bindOrReuseDeviceSession(
            "owner",
            device.deviceId,
            "android",
            image,
            live ? (child as unknown as ChildProcess) : undefined,
          ),
        );
        await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
          description: "listing and probe disagreement",
        });
        if (live) {
          expect(pending.settled()).toBe(false);
          h.manager.bootedDevices = [device];
          h.manager.androidListedDeviceStates.set(device.deviceId, "device");
          h.timer.advanceTime(100);
          expect(await pending.result).toBe("owner");
          expect(h.timer.now()).toBe(100);
          expect(h.pool.getDevice(device.deviceId)).toBe(h.entry);
          expect(h.entry?.sessionId).toBe("owner");
        } else {
          const error = await pending.result;
          expect(error).toBeInstanceOf(ActionableError);
          expect(error).toHaveProperty(
            "message",
            `Device '${device.deviceId}' is not available in the device pool. It may have been shut down or disconnected.`,
          );
          expect(error).not.toHaveProperty("code");
          expect(h.timer.now()).toBe(0);
          h.unchanged();
        }
        expect(probe).toHaveBeenCalledTimes(1);
        expect(child.killed).toBe(false);
        h.noLossSideEffects();
      } finally {
        probe.mockRestore();
      }
    });
  }

  for (const exited of [false, true]) {
    test(`first-boot offline then absent with ${exited ? "exited" : "live"} launch refuses without signalling or shutdown`, async () => {
      const h = await setup(true);
      const child = new FakeChildProcess(h.timer);
      if (exited) {
        child.exitCode = 1;
      }
      const shutdown = spyOn(h.pool, "markIntentionalShutdown");
      try {
        const pending = track(
          h.pool.bindOrReuseDeviceSession(
            "owner",
            device.deviceId,
            "android",
            image,
            child as unknown as ChildProcess,
          ),
        );
        await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
          description: "offline wait before absence",
        });
        h.manager.androidListedDeviceStates.clear();
        h.timer.advanceTime(100);
        if (exited) {
          // The exited fake's piped output closes after process tracking attaches its listener.
          await drainUntil(() => h.timer.getPendingTimeouts().includes(1000), {
            description: "exited launch output close",
          });
          child.emit("close", 1, null);
          await drainUntil(pending.settled, { description: "exited launch refusal" });
        }
        const error = exited
          ? await pending.result
          : await settleByFakeEvents(h.timer, pending.result, {
              description: "absent transport budget",
            });
        if (exited) {
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(DeviceTransportOfflineError);
          expect(error).toHaveProperty(
            "message",
            `Android emulator ${device.deviceId} exited before process tracking completed (code=1, signal=none)`,
          );
          expect(error).not.toHaveProperty("code");
          expect(h.timer.now()).toBe(100);
        } else {
          expect(error).toBeInstanceOf(DeviceTransportOfflineError);
          expect(error).toMatchObject({
            code: "device_offline",
            retryable: true,
            retryAfterMs: 1000,
          });
          expect(error).toHaveProperty(
            "message",
            expect.stringContaining("still running but adb does not list its transport yet"),
          );
          expect(h.timer.now()).toBe(5000);
        }
        expect(child.killed).toBe(false);
        expect(shutdown).not.toHaveBeenCalled();
        if (exited) {
          expect(h.pool.getDevice(device.deviceId)).toBeNull();
          expect(h.remove).toHaveBeenCalledTimes(1);
          expect(h.kill).not.toHaveBeenCalled();
          expect(h.manager.startedDevices).toHaveLength(1);
        } else {
          h.unchanged();
        }
      } finally {
        shutdown.mockRestore();
      }
    });
  }

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

  test("another session's rehydration reservation refuses immediately without probing", async () => {
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
    const probe = spyOn(h.manager, "getAndroidListedDeviceStates");
    try {
      const pending = track(h.bind());
      await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
        description: "rehydration-reserved bind",
      });
      expect(pending.settled()).toBe(true);
      const error = await pending.result;
      expect(error).toBeInstanceOf(InputDeviceOwnedError);
      expect(error).toMatchObject({
        code: "device_owned_by_other_session",
        retryable: false,
        deviceId: device.deviceId,
        message: `Device '${device.deviceId}' is already assigned to session rehydrating-owner`,
      });
      expect(probe).not.toHaveBeenCalled();
      expect(h.timer.now()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      h.unchanged();
    } finally {
      probe.mockRestore();
      h.pool.releaseRehydrationReservation("rehydrating-owner");
    }
  });

  test("another caller's readiness name reservation refuses immediately without probing", async () => {
    const h = await setup(true);
    // A readiness caller reserved this AVD before it moved to the binding serial.
    const reservedDevice = { ...device, deviceId: "emulator-5558" };
    await h.pool.addDevice(reservedDevice, image);
    const release = await h.pool.reserveDeviceForReadiness(
      reservedDevice.deviceId,
      reservedDevice,
      device.name,
      image.name,
    );
    const probe = spyOn(h.manager, "getAndroidListedDeviceStates");
    try {
      const pending = track(h.bind());
      await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
        description: "foreign-readiness bind",
      });
      expect(pending.settled()).toBe(true);
      const error = await pending.result;
      expect(error).toBeInstanceOf(ActionableError);
      expect(error).toHaveProperty(
        "message",
        `Device '${device.deviceId}' is not available in the device pool.`,
      );
      expect(error).not.toHaveProperty("code");
      expect(error).not.toHaveProperty("retryable");
      expect(probe).not.toHaveBeenCalled();
      expect(h.timer.now()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      h.unchanged();
    } finally {
      probe.mockRestore();
      await release();
    }
  });

  test("another session's pooled holder preserves immediate absence without probing", async () => {
    const h = await setup(true);
    h.manager.bootedDevices = [device];
    h.manager.androidListedDeviceStates.clear();
    await h.bind();
    h.manager.bootedDevices = [];
    h.manager.androidListedDeviceStates.set(device.deviceId, "offline");
    const entryBefore = { ...h.entry };
    const probe = spyOn(h.manager, "getAndroidListedDeviceStates");
    try {
      const pending = track(
        h.pool.bindOrReuseDeviceSession("other-session", device.deviceId, "android", image),
      );
      await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
        description: "foreign-holder bind",
      });
      expect(pending.settled()).toBe(true);
      const error = await pending.result;
      expect(error).toBeInstanceOf(ActionableError);
      expect(error).toHaveProperty(
        "message",
        `Device '${device.deviceId}' is not available in the device pool. It may have been shut down or disconnected.`,
      );
      expect(error).not.toHaveProperty("code");
      expect(error).not.toHaveProperty("retryable");
      expect(probe).not.toHaveBeenCalled();
      expect(h.timer.now()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      expect(h.pool.getDevice(device.deviceId)).toBe(h.entry);
      expect(h.entry).toEqual(entryBefore);
      expect(h.entry?.sessionId).toBe("owner");
      h.noLossSideEffects();
    } finally {
      probe.mockRestore();
    }
  });

  for (const autolock of [false, true]) {
    test(`${autolock ? "autolock" : "explicit bind"}: own readiness name reservation still waits then binds`, async () => {
      const h = await setup(true);
      const reservedDevice = { ...device, deviceId: "emulator-5558" };
      await h.pool.addDevice(reservedDevice, image);
      const release = await h.pool.reserveDeviceForReadiness(
        reservedDevice.deviceId,
        reservedDevice,
        device.name,
        image.name,
      );
      const owners = new Set([release.owner]);
      const probe = spyOn(h.manager, "getAndroidListedDeviceStates");
      try {
        const pending = track(
          autolock
            ? h.pool.autolockDevice(
                device.deviceId,
                "android",
                "client",
                image,
                undefined,
                device,
                owners,
              )
            : h.pool.bindOrReuseDeviceSession(
                "owner",
                device.deviceId,
                "android",
                image,
                undefined,
                device,
                false,
                owners,
              ),
        );
        await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
          description: "own-readiness name bind wait",
        });
        expect(pending.settled()).toBe(false);
        expect(probe).toHaveBeenCalledTimes(1);
        h.unchanged();
        h.manager.bootedDevices = [device];
        h.manager.androidListedDeviceStates.set(device.deviceId, "device");
        h.timer.advanceTime(100);
        const sessionId = await pending.result;
        expect(sessionId).toEqual(autolock ? expect.any(String) : "owner");
        expect(h.timer.now()).toBe(100);
        expect(h.pool.getDevice(device.deviceId)).toBe(h.entry);
        expect(h.entry?.sessionId).toBe(sessionId);
        h.noLossSideEffects();
      } finally {
        probe.mockRestore();
        await release();
      }
    });
  }

  test("own rehydration reservation still waits then binds", async () => {
    const h = await setup(true);
    await h.pool.reserveDevicesForRehydration([
      {
        sessionId: "owner",
        target: {
          platform: "android",
          stableDeviceId: device.name,
          deviceId: device.deviceId,
          androidEmulator: true,
        },
      },
    ]);
    const probe = spyOn(h.manager, "getAndroidListedDeviceStates");
    try {
      const pending = track(h.bind());
      await drainUntil(() => pending.settled() || h.timer.getPendingTimeouts().includes(100), {
        description: "own-rehydration bind wait",
      });
      expect(pending.settled()).toBe(false);
      expect(probe).toHaveBeenCalledTimes(1);
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
      probe.mockRestore();
      h.pool.releaseRehydrationReservation("owner");
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
