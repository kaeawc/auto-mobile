import { describe, expect, mock, test } from "bun:test";
import { isAppearanceSyncEnabled } from "../../src/utils/appearance/appearanceSyncPolicy";
import { AppearanceSyncScheduler } from "../../src/daemon/AppearanceSyncScheduler";
import {
  AppearanceSocketServer,
  type AppearanceSocketServerDependencies,
} from "../../src/daemon/appearanceSocketServer";
import type { AppearanceSocketRequest } from "../../src/daemon/appearanceSocketTypes";
import type { AppearanceConfig, BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const config: AppearanceConfig = { syncWithHost: true, defaultMode: "auto", applyOnConnect: true };

function harness(isEnabled: () => boolean = () => true) {
  const timer = new FakeTimer();
  const getConfig = mock(async () => config);
  const apply = mock(async () => {});
  const scheduler = new AppearanceSyncScheduler(timer, {
    isEnabled,
    getConfig,
    resolveMode: async () => "dark",
    getTargets: () => [device],
    apply,
  });
  return { timer, scheduler, getConfig, apply };
}

class RequestOnlyAppearanceServer extends AppearanceSocketServer {
  constructor(dependencies: AppearanceSocketServerDependencies) {
    super(
      "/unused/appearance.sock",
      new FakeTimer(),
      {
        authorize: () => {},
        isAuthenticationEnforced: () => false,
      },
      {
        getPooledDevices: () => [device],
        getCurrentDevice: () => undefined,
        getSessionForDevice: () => null,
      },
      dependencies,
    );
  }

  request(request: AppearanceSocketRequest) {
    return this.handleRequest(request);
  }
}

describe("appearance sync kill switch", () => {
  test.each(["off", "0", "false", "no", " OFF ", " FaLsE "])(
    "sync=%s gates scheduler startup, ticks, discovery/session acquisition, and a permissive scope",
    async (value) => {
      const { timer, scheduler, getConfig, apply } = harness(() => isAppearanceSyncEnabled(value));
      scheduler.setScope({ getTargets: () => [device], isEnabled: () => true });
      scheduler.start();
      timer.advanceTime(10_001);
      await scheduler.trigger();
      await scheduler.syncDevice(device);
      expect(getConfig).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      await scheduler.stop();
      expect(timer.getPendingIntervalCount()).toBe(0);
    },
  );

  test("the scheduler rechecks the switch before writing after an async config read", async () => {
    const apply = mock(async () => {});
    let enabled = true;
    const scheduler = new AppearanceSyncScheduler(new FakeTimer(), {
      isEnabled: () => enabled,
      getConfig: async () => {
        enabled = false;
        return config;
      },
      resolveMode: async () => "dark",
      getTargets: () => [device],
      apply,
    });
    await scheduler.trigger();
    expect(apply).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  test.each(["set_appearance", "set_appearance_sync"] as const)(
    "%s still applies an explicit user request with sync off, without scheduling writes",
    async (command) => {
      const { scheduler, apply: automaticApply } = harness(() => false);
      const explicitApply = mock(async () => {});
      const server = new RequestOnlyAppearanceServer({
        getConfig: async () => config,
        updateConfig: async () => config,
        resolveMode: async () => "dark",
        applyToDevice: explicitApply,
        triggerSync: () => scheduler.trigger(),
        isSyncEnabled: () => false,
      });
      const response = await server.request({
        id: "explicit",
        command,
        mode: "dark",
        enabled: true,
      });
      expect(response.success).toBe(true);
      expect(explicitApply).toHaveBeenCalledWith(device, "dark");
      expect(automaticApply).not.toHaveBeenCalled();
      await scheduler.stop();
    },
  );
});
