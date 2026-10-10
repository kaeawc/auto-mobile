import { expect, test } from "bun:test";
import type { AppearanceConfig } from "../../src/server/appearanceManager";
import { AppearanceSyncScheduler } from "../../src/daemon/AppearanceSyncScheduler";
import { DeviceSettingDefaults } from "../../src/features/utility/DeviceSettingDefaults";
import {
  FakeDeviceSettingDefaultsPersistence,
  FakeDeviceSettings,
} from "../fakes/FakeDeviceSettingDefaults";
import { FakeTimer } from "../fakes/FakeTimer";

const target = { deviceId: "emulator-5554", name: "emulator-5554", platform: "android" as const };

test("a host-appearance-sync night-mode change is reset when another session acquires the device (#11145)", async () => {
  const settings = new FakeDeviceSettings({ nightMode: "light" });
  const defaults = new DeviceSettingDefaults(
    new FakeDeviceSettingDefaultsPersistence(),
    settings,
    () => "session-a",
  );
  const scheduler = new AppearanceSyncScheduler(new FakeTimer(), {
    isEnabled: () => true,
    getConfig: async () => ({ syncWithHost: true }) as AppearanceConfig,
    resolveMode: async () => "dark",
    getTargets: () => [target],
    apply: async (_device, mode) => {
      settings.current.nightMode = mode;
    },
  });
  scheduler.setScope({
    getTargets: () => [{ ...target, sessionKey: "session-a" }],
    beforeApply: (device) => defaults.recordBeforeChange(device, ["nightMode"]),
  });
  await scheduler.trigger();
  expect(settings.current.nightMode).toBe("dark");

  await defaults.resetOnAcquisition(target.deviceId, "session-b");
  expect(settings.current.nightMode).toBe("light");
});
