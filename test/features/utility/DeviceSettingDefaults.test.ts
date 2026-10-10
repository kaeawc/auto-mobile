import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DeviceSettingDefaults,
  createDeviceSettingDefaultsAcquisitionReset,
  type DeviceSettingKey,
  type DeviceSettingValues,
} from "../../../src/features/utility/DeviceSettingDefaults";
import {
  FakeDeviceSettingDefaultsPersistence as FakePersistence,
  FakeDeviceSettings,
} from "../../fakes/FakeDeviceSettingDefaults";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

function harness(initial: DeviceSettingValues) {
  const persistence = new FakePersistence();
  const settings = new FakeDeviceSettings({ ...initial });
  let holder: string | null = "session-a";
  const defaults = new DeviceSettingDefaults(persistence, settings, () => holder);
  return {
    persistence,
    settings,
    defaults,
    hold(sessionId: string | null) {
      holder = sessionId;
    },
    /** A tool changing `values` on the device, recording defaults first as the handlers do. */
    async change(values: DeviceSettingValues) {
      await defaults.recordBeforeChange(device, Object.keys(values) as DeviceSettingKey[]);
      Object.assign(settings.current, values);
    },
  };
}

describe("DeviceSettingDefaults (#11145)", () => {
  test("records the value observed before the first change and keeps it across later changes", async () => {
    const h = harness({ fontScale: "default", nightMode: "light" });
    await h.change({ fontScale: 1.3 });
    await h.change({ fontScale: 2, nightMode: "dark" });
    expect(h.persistence.records.get(device.deviceId)).toEqual({
      platform: "android",
      name: "Pixel",
      sessionId: "session-a",
      values: { fontScale: "default", nightMode: "light" },
    });
  });

  test("a change no session holds the device for is not recorded", async () => {
    const h = harness({ fontScale: "default" });
    h.hold(null);
    await h.change({ fontScale: 1.3 });
    expect(h.persistence.records.size).toBe(0);
  });

  test("acquisition by a different session resets only the settings that differ, then clears the record", async () => {
    const h = harness({ fontScale: "default", density: "default", locale: "en_US" });
    await h.change({ fontScale: 1.3, density: 480 });
    // Changed back by the session itself before release: nothing to reset for density.
    h.settings.current.density = "default";
    await h.defaults.resetOnAcquisition(device.deviceId, "session-b");
    expect(h.settings.writes).toEqual([{ fontScale: "default" }]);
    expect(h.settings.current).toEqual({
      fontScale: "default",
      density: "default",
      locale: "en_US",
    });
    expect(h.persistence.records.size).toBe(0);
  });

  test("the session that changed the settings re-acquiring the device resets nothing", async () => {
    const h = harness({ nightMode: "light" });
    await h.change({ nightMode: "dark" });
    await h.defaults.resetOnAcquisition(device.deviceId, "session-a");
    expect(h.settings.writes).toEqual([]);
    expect(h.settings.current.nightMode).toBe("dark");
    expect(h.persistence.records.get(device.deviceId)?.values).toEqual({ nightMode: "light" });
  });

  test("a setting that fails to reset stays recorded and the next acquisition retries it", async () => {
    const h = harness({ fontScale: "default", calendarSystem: "gregory" });
    await h.change({ fontScale: 1.3, calendarSystem: "japanese" });
    h.settings.failing.add("calendarSystem");
    await h.defaults.resetOnAcquisition(device.deviceId, "session-b");
    expect(h.settings.current).toEqual({ fontScale: "default", calendarSystem: "japanese" });
    expect(h.persistence.records.get(device.deviceId)?.values).toEqual({
      calendarSystem: "gregory",
    });
    h.settings.failing.clear();
    await h.defaults.resetOnAcquisition(device.deviceId, "session-c");
    expect(h.settings.current.calendarSystem).toBe("gregory");
    expect(h.persistence.records.size).toBe(0);
  });

  test("an unset default is reset to unset", async () => {
    const h = harness({ timeFormat: null });
    await h.change({ timeFormat: "24" });
    await h.defaults.resetOnAcquisition(device.deviceId, "session-b");
    expect(h.settings.writes).toEqual([{ timeFormat: null }]);
  });

  test("the record survives a fresh instance over the same persistence (daemon restart)", async () => {
    const h = harness({ nightMode: "light" });
    await h.change({ nightMode: "dark" });
    const restarted = new DeviceSettingDefaults(h.persistence, h.settings, () => null);
    await restarted.resetOnAcquisition(device.deviceId, "session-b");
    expect(h.settings.current.nightMode).toBe("light");
  });

  test("a change recorded after an acquisition reset waits for it and records the reset value", async () => {
    const h = harness({ nightMode: "light" });
    await h.change({ nightMode: "dark" });
    h.hold("session-b");
    const reset = h.defaults.resetOnAcquisition(device.deviceId, "session-b");
    const record = h.defaults.recordBeforeChange(device, ["nightMode"]);
    await Promise.all([reset, record]);
    expect(h.persistence.records.get(device.deviceId)).toMatchObject({
      sessionId: "session-b",
      values: { nightMode: "light" },
    });
  });

  test("the acquisition reset is tracked as acquisition cleanup for the device", async () => {
    const h = harness({ fontScale: "default" });
    await h.change({ fontScale: 1.3 });
    const tracked: Array<[string, Promise<unknown>]> = [];
    const reset = createDeviceSettingDefaultsAcquisitionReset(
      {
        registerAcquisitionDeviceCleanup: (deviceId, cleanup) => tracked.push([deviceId, cleanup]),
      },
      h.defaults,
    );
    reset(device.deviceId, "session-b");
    expect(tracked.map(([deviceId]) => deviceId)).toEqual([device.deviceId]);
    await tracked[0][1];
    expect(h.settings.current.fontScale).toBe("default");
  });
});
