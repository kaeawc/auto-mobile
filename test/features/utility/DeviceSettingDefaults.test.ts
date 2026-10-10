import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DeviceSettingDefaults,
  createDeviceSettingDefaultsAcquisitionReset,
  createDeviceSettingDefaultsIdentityListener,
  PENDING_RESET_WAIT_MS,
  type DeviceSettingKey,
  type DeviceSettingValues,
} from "../../../src/features/utility/DeviceSettingDefaults";
import {
  FakeDeviceSettingDefaultsPersistence as FakePersistence,
  FakeDeviceSettings,
} from "../../fakes/FakeDeviceSettingDefaults";

import { FakeTimer } from "../../fakes/FakeTimer";

/** Device settings whose reads block until released, standing in for a slow adb reset. */
class GatedSettings extends FakeDeviceSettings {
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  open(): void {
    this.release();
  }
  override async read(...args: Parameters<FakeDeviceSettings["read"]>) {
    await this.gate;
    return super.read(...args);
  }
}

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

  describe("pending acquisition reset (#11145)", () => {
    function gated() {
      const persistence = new FakePersistence();
      const settings = new GatedSettings({ nightMode: "light" });
      const timer = new FakeTimer();
      let holder: string | null = "session-b";
      const defaults = new DeviceSettingDefaults(persistence, settings, () => holder, timer, 100);
      persistence.records.set(device.deviceId, {
        platform: "android",
        name: "Pixel",
        sessionId: "session-a",
        values: { nightMode: "light" },
      });
      return { persistence, settings, timer, defaults, hold: (id: string | null) => (holder = id) };
    }

    test("a settings change that records no default still waits for the pending reset", async () => {
      const h = gated();
      h.hold(null);
      const reset = h.defaults.resetOnAcquisition(device.deviceId, "session-b");
      let proceeded = false;
      const record = h.defaults.recordBeforeChange(device, ["nightMode"]).then(() => {
        proceeded = true;
      });
      await Promise.resolve();
      expect(proceeded).toBe(false);
      h.settings.open();
      await Promise.all([reset, record]);
      expect(proceeded).toBe(true);
    });

    test("the wait is bounded: on timeout the change proceeds and its default is not recorded afterwards", async () => {
      const h = gated();
      const reset = h.defaults.resetOnAcquisition(device.deviceId, "session-b");
      const record = h.defaults.recordBeforeChange(device, ["nightMode"]);
      h.timer.advanceTime(100);
      await record;
      // The caller changes the setting; the late record must not take that value for the default.
      h.settings.current.nightMode = "dark";
      h.settings.open();
      await reset;
      await h.defaults.settled(device.deviceId);
      const recorded = h.persistence.records.get(device.deviceId);
      expect(recorded?.values.nightMode).not.toBe("dark");
    });
  });

  describe("reset still running after the wait timed out (#11254)", () => {
    function slow() {
      const persistence = new FakePersistence();
      const settings = new GatedSettings({ fontScale: 1, nightMode: "light" });
      const timer = new FakeTimer();
      const defaults = new DeviceSettingDefaults(persistence, settings, () => "session-b", timer);
      persistence.records.set(device.deviceId, {
        platform: "android",
        name: "Pixel",
        sessionId: "session-a",
        values: { fontScale: 1, nightMode: "light" },
      });
      // Session A had changed both; session B then changed fontScale only.
      settings.current.fontScale = 1.5;
      settings.current.nightMode = "dark";
      return { persistence, settings, timer, defaults };
    }

    test("the late reset does not overwrite the new owner's change and keeps its default recorded", async () => {
      const h = slow();
      const reset = h.defaults.resetOnAcquisition(device.deviceId, "session-b");
      const record = h.defaults.recordBeforeChange(device, ["fontScale"]);
      h.timer.advanceTime(PENDING_RESET_WAIT_MS);
      await record;
      h.settings.current.fontScale = 2;
      h.settings.open();
      await reset;
      expect(h.settings.current.fontScale).toBe(2);
      expect(h.settings.current.nightMode).toBe("light");
      expect(h.persistence.records.get(device.deviceId)).toEqual({
        platform: "android",
        name: "Pixel",
        sessionId: "session-b",
        values: { fontScale: 1 },
      });
    });

    test("the next acquisition by another session then resets the kept key", async () => {
      const h = slow();
      const reset = h.defaults.resetOnAcquisition(device.deviceId, "session-b");
      const record = h.defaults.recordBeforeChange(device, ["fontScale"]);
      h.timer.advanceTime(PENDING_RESET_WAIT_MS);
      await record;
      h.settings.current.fontScale = 2;
      h.settings.open();
      await reset;
      await h.defaults.resetOnAcquisition(device.deviceId, "session-c");
      expect(h.settings.current.fontScale).toBe(1);
      expect(h.persistence.records.has(device.deviceId)).toBe(false);
    });
  });

  describe("device identity replacement (#11145)", () => {
    test("the recorded defaults of the replaced device are dropped", async () => {
      const h = harness({ nightMode: "light" });
      await h.change({ nightMode: "dark" });
      createDeviceSettingDefaultsIdentityListener(h.defaults).onDeviceIdentityReplaced?.(
        device.deviceId,
      );
      await h.defaults.settled(device.deviceId);
      expect(h.persistence.records.size).toBe(0);
      await h.defaults.resetOnAcquisition(device.deviceId, "session-b");
      expect(h.settings.writes).toEqual([]);
    });

    test("a reset queued before the replacement never writes the predecessor's defaults", async () => {
      const persistence = new FakePersistence();
      const settings = new GatedSettings({ nightMode: "dark" });
      const defaults = new DeviceSettingDefaults(persistence, settings, () => "session-b");
      persistence.records.set(device.deviceId, {
        platform: "android",
        name: "Pixel",
        sessionId: "session-a",
        values: { nightMode: "light" },
      });
      const reset = defaults.resetOnAcquisition(device.deviceId, "session-b");
      const forgotten = defaults.forget(device.deviceId);
      settings.open();
      await Promise.all([reset, forgotten]);
      expect(settings.writes).toEqual([]);
      expect(persistence.records.size).toBe(0);
    });

    test("a same-device incarnation change keeps the record", async () => {
      const h = harness({ nightMode: "light" });
      await h.change({ nightMode: "dark" });
      await createDeviceSettingDefaultsIdentityListener(h.defaults).onDeviceIncarnationChanged(
        device.deviceId,
      );
      expect(h.persistence.records.size).toBe(1);
    });
  });
});
