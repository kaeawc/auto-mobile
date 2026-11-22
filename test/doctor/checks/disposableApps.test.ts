import { describe, expect, test } from "bun:test";
import {
  checkExpiredDisposableApps,
  type DisposableAppDoctorDependencies,
} from "../../../src/doctor/checks/disposableApps";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("checkExpiredDisposableApps", () => {
  test("passes for a connected device with no expired apps", async () => {
    const fake: DisposableAppDoctorDependencies = {
      adbFactory: { create: () => ({ getBootedAndroidDevices: async () => [device("clean")] }) },
      lister: { list: async () => [{ appId: "current", expired: false, installed: true }] },
    };
    expect(await checkExpiredDisposableApps({ timer: new FakeTimer() }, fake)).toMatchObject([
      { status: "pass", name: expect.stringContaining("clean") },
    ]);
  });

  test("reports expired installed and registry-only apps on the owning Android device", async () => {
    const fake: DisposableAppDoctorDependencies = {
      adbFactory: {
        create: () => ({ getBootedAndroidDevices: async () => [device("clean"), device("stale")] }),
      },
      lister: {
        list: async (deviceId, platform) => {
          expect(platform).toBe("android");
          return deviceId === "stale"
            ? [
                { appId: "expired-installed", expired: true, installed: true },
                { appId: "expired-registered", expired: true, installed: false },
                { appId: "current", expired: false, installed: true },
              ]
            : [];
        },
      },
    };
    const checks = await checkExpiredDisposableApps({ timer: new FakeTimer() }, fake);
    expect(checks).toMatchObject([
      { status: "pass", name: expect.stringContaining("clean") },
      {
        status: "warn",
        name: expect.stringContaining("stale"),
        recommendation:
          "Run uninstallApp {expired:true} on stale to remove expired-installed, expired-registered.",
      },
    ]);
  });

  test("skips without a connected device", async () => {
    const fake: DisposableAppDoctorDependencies = {
      adbFactory: { create: () => ({ getBootedAndroidDevices: async () => [] }) },
      lister: {
        list: async () => {
          throw new Error("No device should be queried");
        },
      },
    };
    expect(await checkExpiredDisposableApps({ timer: new FakeTimer() }, fake)).toMatchObject([
      { status: "skip" },
    ]);
  });
});

function device(deviceId: string) {
  return { platform: "android" as const, name: deviceId, deviceId };
}
