import { afterEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";
import {
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceManager,
} from "../../../src/server/bootedDeviceResources";
import {
  createDeviceStateChangeNotifier,
  DEVICE_STATE_NOTIFY_DEBOUNCE_MS,
} from "../../../src/server/deviceStateChangeNotifier";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";

// Inventory contract: a device's status is the same on every surface, and a transition between
// idle and assigned reaches subscribers (#11413). A health marker (an app-cleanup, clock, network
// or keep-screen-awake restore that did not complete) moves the device between the pool's `idle`
// and `assigned` buckets, but the SessionManager sets and clears it on the shared marker store
// without telling the pool, so the daemon's debounced resource notifier never fires.

const android: BootedDevice = {
  platform: "android",
  name: "Pixel_9_API_36",
  deviceId: "emulator-5554",
};

describe("health marker transitions reach the booted-devices resource", () => {
  let sessions: SessionManager | undefined;

  afterEach(() => {
    DaemonState.getInstance().reset();
    sessions?.stopCleanupTimer();
    resetBootedDevicesResourceCache();
    setDeviceManager(null);
  });

  async function setup() {
    const timer = new FakeTimer();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", [android]);
    manager.setBootedDevices("ios", []);
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessions = sessionManager;
    let notifications = 0;
    // The same wiring the daemon installs: invalidate the 2.5 s resource cache synchronously,
    // then publish one debounced resource-updated notification.
    const onDeviceStateChanged = createDeviceStateChangeNotifier({
      timer,
      invalidate: resetBootedDevicesResourceCache,
      notify: async () => {
        notifications++;
      },
    });
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "hunt-health-marker", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        onDeviceStateChanged,
      }),
    );
    await pool.initializeWithDevices([android]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    setDeviceManager(manager);
    return { timer, pool, sessionManager, notifications: () => notifications };
  }

  test("a marker set on an idle device invalidates the resource and notifies subscribers", async () => {
    const ctx = await setup();
    const first = await getBootedDevicesForPlatforms(["android"], ctx.timer);
    expect(first.devices[0]?.runtime.poolStatus).toBe("idle");
    expect(ctx.pool.poolBucket(android.deviceId)).toBe("idle");

    ctx.sessionManager.markDeviceNeedsAppCleanup(
      android.deviceId,
      () => new Promise<void>(() => {}),
      1_000,
    );
    expect(ctx.pool.poolBucket(android.deviceId)).toBe("assigned");

    const second = await getBootedDevicesForPlatforms(["android"], ctx.timer);
    await ctx.timer.advanceTimeAsync(DEVICE_STATE_NOTIFY_DEBOUNCE_MS);
    expect({
      resourcePoolStatus: second.devices[0]?.runtime.poolStatus,
      subscribersNotified: ctx.notifications() > 0,
    }).toEqual({ resourcePoolStatus: "assigned", subscribersNotified: true });
  });

  test("a marker cleared by a successful recovery notifies subscribers the device is free", async () => {
    const ctx = await setup();
    ctx.sessionManager.markDeviceNeedsAppCleanup(android.deviceId, async () => {}, 1_000);
    expect(ctx.pool.poolBucket(android.deviceId)).toBe("assigned");
    await getBootedDevicesForPlatforms(["android"], ctx.timer);
    await ctx.timer.advanceTimeAsync(DEVICE_STATE_NOTIFY_DEBOUNCE_MS);
    const notifiedBeforeRecovery = ctx.notifications();

    // Health recovery backs off, retries, and clears the marker.
    await ctx.timer.advanceTimeAsync(10_000);
    expect(ctx.pool.poolBucket(android.deviceId)).toBe("idle");

    const afterRecovery = await getBootedDevicesForPlatforms(["android"], ctx.timer);
    await ctx.timer.advanceTimeAsync(DEVICE_STATE_NOTIFY_DEBOUNCE_MS);
    expect({
      resourcePoolStatus: afterRecovery.devices[0]?.runtime.poolStatus,
      subscribersNotified: ctx.notifications() > notifiedBeforeRecovery,
    }).toEqual({ resourcePoolStatus: "idle", subscribersNotified: true });
  });
});
