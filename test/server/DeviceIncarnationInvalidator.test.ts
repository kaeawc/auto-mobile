import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { createDeviceRestoreEpochHarness } from "../helpers/deviceRestoreEpochHarness";
import { createRegistryDeviceSessionResolver } from "../../src/daemon/deviceSessionResolver";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  DefaultDeviceIncarnationInvalidator,
  type CtrlProxyClientLifecycle,
} from "../../src/server/DeviceIncarnationInvalidator";
import type { DeviceWindowCacheInvalidator } from "../../src/features/action/TerminateApp";
import { PerDeviceInstalledAppsCacheWriteCoordinator } from "../../src/db/installedAppsCacheWriteCoordinator";
import type { BootedDevice } from "../../src/models";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { logger } from "../../src/utils/logger";
import type { DeviceIncarnationListener } from "../../src/utils/deviceIncarnation";
import { createInstalledAppsDeviceIncarnationListener } from "../../src/server/appResources";

const ANDROID_DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel_9_Pro",
  platform: "android",
};

describe("DefaultDeviceIncarnationInvalidator", () => {
  afterEach(() => DaemonState.getInstance().reset());

  test("restore does not establish an epoch for an unregistered or unpooled device", async () => {
    const { registry } = await createDeviceRestoreEpochHarness(ANDROID_DEVICE, new FakeTimer());
    registry.onDeviceDisconnected(ANDROID_DEVICE.deviceId);
    const invalidator = new DefaultDeviceIncarnationInvalidator([]);
    expect(await invalidator.invalidate(ANDROID_DEVICE)).toBeUndefined();
    expect(
      await invalidator.invalidate({ ...ANDROID_DEVICE, deviceId: "emulator-9999" }),
    ).toBeUndefined();
    expect(registry.list()).toEqual([]);
    DaemonState.getInstance().reset();
    expect(await invalidator.invalidate(ANDROID_DEVICE)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  test("restore re-mints before every listener and a racing reconnect cannot mint twice", async () => {
    const { registry, pool, incarnation } = await createDeviceRestoreEpochHarness(
      ANDROID_DEVICE,
      new FakeTimer(),
    );
    const resolver = createRegistryDeviceSessionResolver(registry);
    const stamped: Array<string | null> = [];
    const invalidator = new DefaultDeviceIncarnationInvalidator([
      {
        name: "frames",
        onDeviceIncarnationChanged: (id) => {
          stamped.push(resolver.resolveUuid(id));
        },
      },
      {
        name: "reconnect",
        onDeviceIncarnationChanged: (id) => {
          registry.onDeviceConnected({
            ...ANDROID_DEVICE,
            incarnation: pool.getDeviceIncarnation(id)!,
          });
          registry.onDeviceConnected({ ...ANDROID_DEVICE, incarnation });
          stamped.push(resolver.resolveUuid(id));
        },
      },
    ]);
    expect(await invalidator.invalidate(ANDROID_DEVICE)).toBe("epoch-new");
    expect(stamped).toEqual(["epoch-new", "epoch-new"]);
    expect(registry.getByUuid("epoch-old")).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });
  test("clears window state, closes and evicts CtrlProxy, and marks installed apps stale", async () => {
    let windowInvalidations = 0;
    const windowCacheInvalidator: DeviceWindowCacheInvalidator = {
      invalidate: () => {
        windowInvalidations += 1;
      },
    };
    const installedApps = new FakeInstalledAppsRepository();
    await installedApps.seedInstalledApp(ANDROID_DEVICE.deviceId, 0, "com.example.app", false, 123);
    const barrier = new FakeDbWriteBarrier();
    const calls: string[] = [];
    const markDeviceStale = installedApps.markDeviceStale.bind(installedApps);
    installedApps.markDeviceStale = async (deviceId) => {
      calls.push(`db:${deviceId}`);
      await markDeviceStale(deviceId);
    };
    const ctrlProxyLifecycle: CtrlProxyClientLifecycle = {
      closeAndRemove: async (deviceId) => {
        calls.push(`ctrlproxy:${deviceId}`);
      },
    };
    const invalidator = new DefaultDeviceIncarnationInvalidator([
      {
        name: "observe-window-cache",
        onDeviceIncarnationChanged: () => windowCacheInvalidator.invalidate(ANDROID_DEVICE),
      },
      {
        name: "ctrlproxy-client",
        onDeviceIncarnationChanged: async (deviceId) =>
          await ctrlProxyLifecycle.closeAndRemove(deviceId),
      },
      {
        name: "installed-apps",
        onDeviceIncarnationChanged: async (deviceId) => {
          await new PerDeviceInstalledAppsCacheWriteCoordinator(() => barrier).invalidate(
            deviceId,
            async () => await barrier.track(() => installedApps.markDeviceStale(deviceId)),
          );
          calls.push(`resource-cache:${deviceId}`);
        },
      },
    ]);

    await invalidator.invalidate(ANDROID_DEVICE);

    expect(windowInvalidations).toBe(1);
    expect(calls).toEqual([
      `ctrlproxy:${ANDROID_DEVICE.deviceId}`,
      `db:${ANDROID_DEVICE.deviceId}`,
      `resource-cache:${ANDROID_DEVICE.deviceId}`,
    ]);
    expect(barrier.trackCalls).toBe(1);
    expect(await installedApps.getCacheVerifiedAt(ANDROID_DEVICE.deviceId)).toBe(0);
  });

  test("logs a rejected listener and completes the already-restored invalidation", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const installedApps = new FakeInstalledAppsRepository();
    installedApps.markDeviceStale = async () => {
      throw new Error("markDeviceStale rejected");
    };
    const barrier = new FakeDbWriteBarrier();
    const listeners: DeviceIncarnationListener[] = [
      createInstalledAppsDeviceIncarnationListener(
        installedApps,
        new PerDeviceInstalledAppsCacheWriteCoordinator(() => barrier),
        barrier,
        () => {},
      ),
    ];

    await expect(
      new DefaultDeviceIncarnationInvalidator(listeners).invalidate(ANDROID_DEVICE),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("installed-apps"), expect.any(Error));
    warn.mockRestore();
  });

  test("settles Android listeners independently and logs notification rejection", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const apps = new FakeInstalledAppsRepository();
      const barrier = new FakeDbWriteBarrier();
      const failure = new Error("notify failed");
      const calls: string[] = [];
      const invalidator = new DefaultDeviceIncarnationInvalidator([
        createInstalledAppsDeviceIncarnationListener(
          apps,
          new PerDeviceInstalledAppsCacheWriteCoordinator(() => barrier),
          barrier,
          () => {},
          async () => {
            throw failure;
          },
        ),
        {
          name: "sync-failure",
          onDeviceIncarnationChanged: () => {},
          onIncarnationChangeSettled: () => {
            throw new Error("sync failed");
          },
        },
        {
          name: "recordings",
          onDeviceIncarnationChanged: () => {},
          onIncarnationChangeSettled: (id, outcome) => {
            calls.push(`${id}:${outcome.ready}`);
          },
        },
      ]);
      await expect(
        invalidator.settleIncarnationChange(ANDROID_DEVICE, { ready: true }),
      ).resolves.toBeUndefined();
      expect(calls).toEqual([`${ANDROID_DEVICE.deviceId}:true`]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("installed-apps"), failure);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("sync-failure"), expect.any(Error));
      await invalidator.settleIncarnationChange(
        { ...ANDROID_DEVICE, platform: "ios" },
        { ready: false },
      );
      expect(calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("prepares recording cleanup before a VM load", async () => {
    const calls: string[] = [];
    const invalidator = new DefaultDeviceIncarnationInvalidator([
      {
        name: "recordings",
        onDeviceIncarnationChanged: () => {},
        prepareForIncarnationChange: async () => {
          calls.push("recordings");
        },
      } as DeviceIncarnationListener & {
        prepareForIncarnationChange(deviceId: string): Promise<void>;
      },
    ]);

    const preparation = invalidator as DefaultDeviceIncarnationInvalidator & {
      prepareForIncarnationChange(device: BootedDevice): Promise<void>;
    };
    await preparation.prepareForIncarnationChange(ANDROID_DEVICE);

    expect(calls).toEqual(["recordings"]);
  });

  test("notifies installed-app resource subscribers only on ready settlement", async () => {
    const installedApps = new FakeInstalledAppsRepository();
    const barrier = new FakeDbWriteBarrier();
    const calls: string[] = [];
    const createListener = createInstalledAppsDeviceIncarnationListener as unknown as (
      repository: FakeInstalledAppsRepository,
      coordinator: PerDeviceInstalledAppsCacheWriteCoordinator,
      barrier: FakeDbWriteBarrier,
      invalidateCache: (deviceId: string) => void,
      notifyResourcesUpdated: (deviceId: string) => Promise<void>,
    ) => DeviceIncarnationListener;
    const listener = createListener(
      installedApps,
      new PerDeviceInstalledAppsCacheWriteCoordinator(() => barrier),
      barrier,
      (deviceId) => calls.push(`clear:${deviceId}`),
      async (deviceId) => {
        calls.push(`notify:${deviceId}`);
      },
    );

    await listener.onDeviceIncarnationChanged(ANDROID_DEVICE.deviceId);

    expect(calls).toEqual([`clear:${ANDROID_DEVICE.deviceId}`]);
    await listener.onIncarnationChangeSettled?.(ANDROID_DEVICE.deviceId, { ready: false });
    expect(calls).toEqual([`clear:${ANDROID_DEVICE.deviceId}`]);
    await listener.onIncarnationChangeSettled?.(ANDROID_DEVICE.deviceId, { ready: true });
    expect(calls).toEqual([
      `clear:${ANDROID_DEVICE.deviceId}`,
      `notify:${ANDROID_DEVICE.deviceId}`,
    ]);
  });
});
