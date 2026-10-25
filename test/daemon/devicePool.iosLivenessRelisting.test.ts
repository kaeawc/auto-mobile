import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DevicePool } from "../../src/daemon/devicePool";
import type { SessionManager } from "../../src/daemon/sessionManager";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import { IOS_LIVENESS_UNVERIFIED_RETRY_AFTER_MS } from "../../src/daemon/devicePoolParts/contracts";
import type { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import type { FakeTimer } from "../fakes/FakeTimer";
import { createBootedDevice, createDevicePoolSuite } from "../helpers/devicePoolSuite";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";

useSessionIdleWindowForSuite();

// #15289: a `simctl list` timeout during a boot burst must not fail the bind non-retryably.
describe("iOS exact-device bind re-lists after a failed liveness listing (#15289)", () => {
  let devicePool: DevicePool;
  let sessionManager: SessionManager;
  let fakeDeviceManager: FakeDeviceManager;
  let fakeTimer: FakeTimer;
  const device = createBootedDevice("sim-1", "ios", "iPhone 15");

  beforeEach(async () => {
    ({ devicePool, sessionManager, fakeDeviceManager, fakeTimer } = createDevicePoolSuite());
    await devicePool.initializeWithDevices([device]);
    fakeDeviceManager.bootedDevices = [device];
    fakeDeviceManager.failedSources.add("ios-simulator");
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  const bind = () =>
    devicePool.bindOrReuseDeviceSession({
      sessionId: "session-1",
      deviceId: "sim-1",
      platform: "ios",
    });

  test("a listing that recovers within the backoff binds the device", async () => {
    const bound = bind();
    await drainUntilQuiescent(fakeTimer);
    expect(fakeTimer.getPendingTimeouts()).toEqual([1_000]);
    fakeDeviceManager.failedSources.delete("ios-simulator");
    fakeTimer.advanceTime(1_000);
    expect(await bound).toBe("session-1");
  });

  test("a listing that never recovers is the typed retryable error with a wait hint", async () => {
    const bound = bind();
    const rejection = bound.catch((error: unknown) => error);
    for (const delay of [1_000, 2_000, 4_000]) {
      await drainUntilQuiescent(fakeTimer);
      expect(fakeTimer.getPendingTimeouts()).toEqual([delay]);
      fakeTimer.advanceTime(delay);
    }
    const error = await rejection;
    expect(error).toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
    expect(error).toMatchObject({
      code: "discovery_incomplete",
      retryable: true,
      retryAfterMs: IOS_LIVENESS_UNVERIFIED_RETRY_AFTER_MS,
    });
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
  });
});
