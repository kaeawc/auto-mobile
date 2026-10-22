import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AppearanceConfig, AppearanceConfigInput, BootedDevice } from "../../src/models";
import { parseAppearanceConfig } from "../../src/features/appearance/AppearanceConfig";
import {
  AppearanceSyncScheduler,
  type AppearanceSyncTarget,
} from "../../src/daemon/AppearanceSyncScheduler";
import { registerAppearanceClaimSync } from "../../src/daemon/appearanceClaimSync";
import { resolveAppearanceSessionKey } from "../../src/daemon/appearanceSessionKey";
import { appearanceSyncTargets } from "../../src/daemon/appearanceSyncTargets";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { RealToolCallPath } from "../helpers/realToolCallPath";

/**
 * #11363: an observer's explicit light/dark was saved but never applied. `setActiveDevice` claims a
 * device without device readiness, so `applyOnConnect` never ran, the session-created sync skipped
 * any config that does not follow the host, and a rebind applied nothing at all. The real
 * `setActiveDevice` path claims and rebinds here; only the config store and the device write are
 * fake.
 */

const DEFAULTS: AppearanceConfig = {
  syncWithHost: true,
  defaultMode: "auto",
  applyOnConnect: true,
};
const OBSERVER = "observer-1";

class FakeConfigStore {
  readonly rows = new Map<string, AppearanceConfig>();

  get = async (sessionKey?: string): Promise<AppearanceConfig> =>
    this.rows.get(sessionKey ?? "") ?? DEFAULTS;

  update = async (update: AppearanceConfigInput, sessionKey: string): Promise<void> => {
    this.rows.set(
      sessionKey,
      parseAppearanceConfig({ ...(await this.get(sessionKey)), ...update }),
    );
  };
}

describe("a session's appearance is applied to the device it claims (#11363)", () => {
  const pixel: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
  const fold: BootedDevice = { name: "Fold", deviceId: "emulator-5556", platform: "android" };

  let manager: SessionManager;
  let tools: RealToolCallPath;
  let store: FakeConfigStore;
  let applied: string[];
  let syncs: Promise<void>[];
  let spies: Array<ReturnType<typeof spyOn>>;

  const setup = async () => {
    const timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [pixel, fold]);
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "appearance-claim-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([pixel, fold]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    tools = new RealToolCallPath([pixel, fold]).install();

    store = new FakeConfigStore();
    applied = [];
    syncs = [];
    const policy = { allows: () => true };
    const scheduler = new AppearanceSyncScheduler(timer, {
      isEnabled: () => true,
      getConfig: store.get,
      // Only explicit choices are exercised; a host-following one would read the host.
      resolveMode: async (config) => (config?.defaultMode === "dark" ? "dark" : "light"),
      apply: async (device, mode) => {
        applied.push(`${device.deviceId}:${mode}`);
      },
    });
    // The daemon's scope: each device tagged with the session holding it right now.
    scheduler.setScope({ getTargets: () => appearanceSyncTargets(pool, policy, manager) });
    registerAppearanceClaimSync(
      manager,
      { devicePool: () => pool, passiveWorkPolicy: () => policy },
      {
        sync: (target: AppearanceSyncTarget) => {
          const sync = scheduler.syncDevice(target);
          syncs.push(sync);
          return sync;
        },
        resolveSessionKey: (sessionId) => resolveAppearanceSessionKey(sessionId),
      },
    );
  };

  const settleSyncs = async () => {
    await Promise.all(syncs.splice(0));
  };

  // CI's per-test time excludes only beforeAll: one throwaway claim pays the tool path's one-time
  // module/JIT cost here, not in the first timed test.
  beforeAll(async () => {
    const warmSpies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
    ];
    try {
      await setup();
      await tools.call("setActiveDevice", { deviceId: pixel.deviceId, sessionUuid: OBSERVER });
      await settleSyncs();
    } finally {
      tools.uninstall();
      DaemonState.getInstance().reset();
      manager.stopCleanupTimer();
      for (const spy of warmSpies) {
        spy.mockRestore();
      }
    }
  });

  beforeEach(() => {
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    tools.uninstall();
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("an observer that stored dark and claims a device through setActiveDevice gets dark", async () => {
    await setup();
    // `set_appearance dark` from a session that holds no device: stored, applied to nothing.
    await store.update({ syncWithHost: false, defaultMode: "dark" }, OBSERVER);

    await tools.call("setActiveDevice", { deviceId: pixel.deviceId, sessionUuid: OBSERVER });
    await settleSyncs();

    expect(manager.getSession(OBSERVER)?.assignedDevice).toBe(pixel.deviceId);
    expect(applied).toEqual(["emulator-5554:dark"]);
  });

  test("a rebind from one device to another applies the session's mode on the new device", async () => {
    await setup();
    await store.update({ syncWithHost: false, defaultMode: "dark" }, OBSERVER);
    await tools.call("setActiveDevice", { deviceId: pixel.deviceId, sessionUuid: OBSERVER });
    await settleSyncs();

    await tools.call("setActiveDevice", { deviceId: fold.deviceId, sessionUuid: OBSERVER });
    await settleSyncs();

    expect(manager.getSession(OBSERVER)?.assignedDevice).toBe(fold.deviceId);
    expect(applied).toEqual(["emulator-5554:dark", "emulator-5556:dark"]);
  });

  test("a claim leaves the device alone when the session does not apply on connect", async () => {
    await setup();
    await store.update(
      { syncWithHost: false, defaultMode: "dark", applyOnConnect: false },
      OBSERVER,
    );

    await tools.call("setActiveDevice", { deviceId: pixel.deviceId, sessionUuid: OBSERVER });
    await tools.call("setActiveDevice", { deviceId: fold.deviceId, sessionUuid: OBSERVER });
    await settleSyncs();

    expect(manager.getSession(OBSERVER)?.assignedDevice).toBe(fold.deviceId);
    expect(applied).toEqual([]);
  });
});
