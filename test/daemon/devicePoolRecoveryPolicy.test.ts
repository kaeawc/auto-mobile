import { describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";

describe("DevicePool recovery eligibility", () => {
  test("only reports AutoMobile-started Android virtual devices as recovery eligible", async () => {
    const timer = new FakeTimer();
    const pool = new DevicePool(
      new SessionManager(timer, new FakeDeviceSessionPersistence()),
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      new FakeDeviceManager(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { onLoss: true, maxAttempts: 1 },
    );

    await pool.initializeWithDevices([
      {
        name: "External Pixel",
        platform: "android",
        deviceId: "emulator-5554",
      },
      {
        name: "Physical iPhone",
        platform: "ios",
        deviceId: "physical-ios-device",
      },
    ]);
    await pool.addDevice(
      {
        name: "AutoMobile Pixel",
        platform: "android",
        deviceId: "emulator-5556",
      },
      {
        name: "AutoMobile Pixel",
        platform: "android",
        isRunning: false,
        source: "local",
      },
    );

    expect(pool.getRecoveryPolicy()).toEqual({ onLoss: true, maxAttempts: 1 });
    expect(pool.getRecoveryEligibility("emulator-5554")).toEqual({
      eligible: false,
      reason: "not-automobile-owned",
    });
    expect(pool.getRecoveryEligibility("physical-ios-device")).toEqual({
      eligible: false,
      reason: "unsupported-platform",
    });
    expect(pool.getRecoveryEligibility("emulator-5556")).toEqual({
      eligible: true,
      action: "restart",
    });
  });
});
