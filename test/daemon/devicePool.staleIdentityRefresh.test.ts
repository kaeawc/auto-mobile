import { makePool } from "../helpers/makePool";
import { expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

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
  const pool = makePool(sessions, "daemon-test", {
    timer,
    deviceManager: manager,
  });
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

    let replacementAttempts = 0;
    pool.testHooks.replacePooledDeviceForRuntimeIdentity.intercept(
      (replace) => async (entry, observation) => {
        replacementAttempts++;
        return replace(entry, observation);
      },
    );
    const replaced = await pool.testHooks.foldObservationIntoPooledEntry(pooled, stale, "refresh");

    expect(replaced).toBe(false);
    expect(replacementAttempts).toBe(0);
    expect(pool.getDevice(original.deviceId)).toBe(pooled);
    expect(pooled).toMatchObject({ name: original.name, identityObservedAt: 10 });
  } finally {
    sessions.stopCleanupTimer();
  }
});
