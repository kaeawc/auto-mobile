import { expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { DevicePool, type PooledDevice } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

test("a stale refresh entry cannot replace a runtime confirmed by newer discovery", async () => {
  const original: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel_8_API_35",
    platform: "android",
    observedAt: 1,
  };
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
  try {
    await pool.initializeWithDevices([original]);
    const pooled = pool.getDevice(original.deviceId);
    if (!pooled) {
      throw new Error("Expected a pooled emulator");
    }
    await pool.reconcileDiscoveryObservation(
      [{ ...original, observedAt: 10 }],
      "test:newer-observation",
    );
    expect(pooled.identityObservedAt).toBe(10);
    const stale = { ...original, name: "Pixel_7_API_34", observedAt: 9 };
    manager.bootedDevices = [stale];

    const fold = pool as unknown as {
      foldObservationIntoPooledEntry(
        entry: PooledDevice,
        observation: BootedDevice,
        source: "refresh",
      ): Promise<boolean>;
      replacePooledDeviceForRuntimeIdentity(
        entry: PooledDevice,
        observation: BootedDevice,
      ): Promise<boolean>;
    };
    const replace = fold.replacePooledDeviceForRuntimeIdentity.bind(pool);
    let replacementAttempts = 0;
    fold.replacePooledDeviceForRuntimeIdentity = async (entry, observation) => {
      replacementAttempts++;
      return replace(entry, observation);
    };
    const replaced = await fold.foldObservationIntoPooledEntry(pooled, stale, "refresh");

    expect(replaced).toBe(false);
    expect(replacementAttempts).toBe(0);
    expect(pool.getDevice(original.deviceId)).toBe(pooled);
    expect(pooled).toMatchObject({ name: original.name, identityObservedAt: 10 });
  } finally {
    sessions.stopCleanupTimer();
  }
});
