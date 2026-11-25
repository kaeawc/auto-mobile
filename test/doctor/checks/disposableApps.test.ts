import { describe, expect, spyOn, test } from "bun:test";
import {
  checkExpiredDisposableApps,
  checkExpiredIosDisposableApps,
  type DisposableAppDoctorDependencies,
  type DisposableAppLister,
  type IosDisposableAppDoctorDependencies,
} from "../../../src/doctor/checks/disposableApps";
import { logger } from "../../../src/utils/logger";
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

describe("checkExpiredIosDisposableApps (#14184)", () => {
  const unqueried: DisposableAppLister = {
    list: async () => {
      throw new Error("No simulator should be queried");
    },
  };
  const ios = (
    overrides: Partial<IosDisposableAppDoctorDependencies> & {
      simulators?: string[];
      available?: boolean;
    } = {},
  ): IosDisposableAppDoctorDependencies => ({
    platform: () => "darwin",
    simctl: {
      isAvailable: async () => overrides.available ?? true,
      getBootedSimulatorsChecked: async () =>
        (overrides.simulators ?? []).map((deviceId) => ({
          platform: "ios" as const,
          name: deviceId,
          deviceId,
        })),
    },
    lister: unqueried,
    ...overrides,
  });

  test("reports expired apps on each booted simulator", async () => {
    const lister: DisposableAppLister = {
      list: async (deviceId, platform) => {
        expect(platform).toBe("ios");
        return deviceId === "STALE-UDID"
          ? [{ appId: "dev.jasonpearson.automobile.app.feed-1", expired: true, installed: true }]
          : [{ appId: "dev.jasonpearson.automobile.app.ok-2", expired: false, installed: true }];
      },
    };
    const checks = await checkExpiredIosDisposableApps(
      { timer: new FakeTimer() },
      ios({ simulators: ["CLEAN-UDID", "STALE-UDID"], lister }),
    );
    expect(checks).toMatchObject([
      { status: "pass", name: expect.stringContaining("CLEAN-UDID") },
      {
        status: "warn",
        name: expect.stringContaining("STALE-UDID"),
        recommendation:
          "Run uninstallApp {expired:true} on STALE-UDID to remove dev.jasonpearson.automobile.app.feed-1.",
      },
    ]);
  });

  test.each([
    ["off macOS", ios({ platform: () => "linux", simulators: ["UDID"] })],
    ["without simctl", ios({ available: false, simulators: ["UDID"] })],
    ["with no booted simulator", ios()],
  ])("skips %s", async (_label, dependencies) => {
    expect(
      await checkExpiredIosDisposableApps({ timer: new FakeTimer() }, dependencies),
    ).toMatchObject([{ status: "skip", name: expect.stringContaining("iOS") }]);
  });

  test("warns when the simulator listing fails", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const failing = ios();
      failing.simctl.getBootedSimulatorsChecked = async () => {
        throw new Error("simctl list timed out");
      };
      expect(
        await checkExpiredIosDisposableApps({ timer: new FakeTimer() }, failing),
      ).toMatchObject([
        { status: "warn", message: expect.stringContaining("simctl list timed out") },
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

function device(deviceId: string) {
  return { platform: "android" as const, name: deviceId, deviceId };
}
