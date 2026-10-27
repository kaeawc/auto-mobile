import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DEVICE_LOCK_STATES_RESOURCE_URI,
  type DeviceLockStatesResourceContent,
  getBootedDevicesForPlatforms,
  registerBootedDeviceResources,
  resetBootedDevicesResourceCache,
  setDeviceLockProbe,
  setDeviceManager,
} from "../../../src/server/bootedDeviceResources";
import { ResourceRegistry } from "../../../src/server/resourceRegistry";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntil } from "../../helpers/fakeTimerStepping";

const ios: BootedDevice = {
  name: "iPhone 15 Pro",
  platform: "ios",
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  source: "local",
};

async function readLockStates(): Promise<DeviceLockStatesResourceContent> {
  const resource = ResourceRegistry.getResource(DEVICE_LOCK_STATES_RESOURCE_URI);
  if (!resource) {
    throw new Error("Lock-state resource was not registered");
  }
  const content = await resource.handler();
  return JSON.parse(content.text!);
}

describe("booted device lock probe signals", () => {
  let timer: FakeTimer;
  let registrySnapshot: ReturnType<typeof ResourceRegistry.snapshotForTesting>;
  let restoreTimer: () => void;

  beforeEach(() => {
    // bunfig.toml's test preload isolates AUTOMOBILE_* directories before production imports.
    resetBootedDevicesResourceCache();
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("ios", [ios]);
    setDeviceManager(utils);
    registrySnapshot = ResourceRegistry.snapshotForTesting();
    registerBootedDeviceResources();
    timer = new FakeTimer();
    // The lock-state resource has no timer parameter; use the existing default timer seam.
    const schedule = spyOn(defaultTimer, "setTimeout").mockImplementation((callback, ms) =>
      timer.setTimeout(callback, ms),
    );
    const clear = spyOn(defaultTimer, "clearTimeout").mockImplementation((handle) =>
      timer.clearTimeout(handle),
    );
    restoreTimer = () => {
      schedule.mockRestore();
      clear.mockRestore();
    };
  });

  afterEach(() => {
    restoreTimer();
    timer.reset();
    setDeviceLockProbe(null);
    setDeviceManager(null);
    resetBootedDevicesResourceCache();
    ResourceRegistry.restoreForTesting(registrySnapshot);
  });

  test("lock-state resource forwards the exact request signal to the probe", async () => {
    const controller = new AbortController();
    const calls: Array<{ device: BootedDevice; signal?: AbortSignal }> = [];
    setDeviceLockProbe(async (device, signal?: AbortSignal) => {
      calls.push({ device, signal });
      return true;
    });

    const result = await runWithAbortSignal(controller.signal, readLockStates);

    expect(calls).toEqual([{ device: ios, signal: controller.signal }]);
    expect(calls[0].signal).toBe(controller.signal);
    expect(result.lockStates).toEqual([{ deviceId: ios.deviceId, locked: true }]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("booted-device enrichment supplies its signal to the probe", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    setDeviceLockProbe(async (_device, signal?: AbortSignal) => {
      signals.push(signal);
      return false;
    });

    const result = await getBootedDevicesForPlatforms(["ios"], timer);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].runtime.locked).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("aborting a hanging lock probe returns unknown without advancing to its deadline", async () => {
    const controller = new AbortController();
    let probeStarted = false;
    setDeviceLockProbe(() => {
      probeStarted = true;
      return new Promise<boolean | undefined>(() => {});
    });

    const reading = runWithAbortSignal(controller.signal, readLockStates);
    await drainUntil(() => probeStarted && timer.getPendingTimeoutCount() === 1, {
      description: "hanging lock probe and its deadline",
    });
    expect(timer.getPendingTimeouts()).toEqual([3000]);
    controller.abort();

    let settled = false;
    void reading.then(() => {
      settled = true;
    });
    await drainUntil(() => settled, { description: "cancelled lock-state read" });
    const result = await reading;

    expect(result.lockStates).toEqual([{ deviceId: ios.deviceId }]);
    expect(result.lockStates[0].locked).toBeUndefined();
    expect(timer.now()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
