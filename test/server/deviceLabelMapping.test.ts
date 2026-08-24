import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { BootedDevice } from "../../src/models";
import { buildDeviceLabelMap, getDeviceLabelMap } from "../../src/server/deviceLabelMapping";

/**
 * Behavioral coverage for the device-label map's read/write path through the REAL
 * SessionManager typed `deviceLabels` slot (issue #2973). The socketServer routing
 * tests inject a fake `getDeviceLabels`, so they prove socketServer *calls* the
 * helper but never exercise the real typed-slot read — this suite closes that gap.
 */
describe("deviceLabelMapping ↔ SessionManager.deviceLabels slot (issue #2973)", () => {
  const androidA: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };
  let sessionManager: SessionManager;

  beforeEach(async () => {
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
    );
    await pool.initializeWithDevices([androidA]);
    DaemonState.getInstance().initialize(sessionManager, pool);
  });

  afterEach(() => {
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  test("getDeviceLabelMap round-trips a map written via the typed setDeviceLabels slot", async () => {
    await sessionManager.createSession("base", "emulator-5554", "android");
    const map = buildDeviceLabelMap(["A", "B"], "base");
    sessionManager.setDeviceLabels("base", map);

    // getDeviceLabelMap reads through the real getDeviceLabels delegation, not a fake.
    expect(getDeviceLabelMap("base")).toEqual(map);
    expect(getDeviceLabelMap("base")).toEqual({ A: "base", B: "base:B" });
  });

  test("getDeviceLabelMap returns null for a session with no registered labels", async () => {
    await sessionManager.createSession("base", "emulator-5554", "android");
    expect(getDeviceLabelMap("base")).toBeNull();
  });

  test("getDeviceLabelMap returns null for an unknown session", () => {
    expect(getDeviceLabelMap("nope")).toBeNull();
  });

  test("getDeviceLabelMap returns null when the daemon is not initialized", () => {
    DaemonState.getInstance().reset();
    expect(getDeviceLabelMap("base")).toBeNull();
  });
});
