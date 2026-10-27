import { describe, expect, test } from "bun:test";
import {
  PlanDeviceLossMonitor,
  PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS,
  type PlanDeviceLossPort,
} from "../../src/daemon/planDeviceLossMonitor";
import type { BootedDeviceDiscovery } from "../../src/devices/deviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createPooledDevice } from "./helpers/DaemonDisconnectHarness";

function harness() {
  const timer = new FakeTimer();
  const ios = createPooledDevice("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", {
    platform: "ios",
    sessionId: "ios-holder",
    status: "busy",
  });
  const android = createPooledDevice("emulator-5554", {
    sessionId: "android-holder",
    status: "busy",
  });
  const devices = new Map([
    [ios.id, ios],
    [android.id, android],
  ]);
  const lost: string[] = [];
  const finished: Array<string | undefined> = [];
  const cancelled: string[] = [];
  let discovery: BootedDeviceDiscovery = {
    devices: [],
    succeededPlatforms: new Set(["android", "ios"]),
    succeededSources: new Set(["android", "ios-simulator"]),
  };
  let adbReset = false;
  let offlineFailure = false;
  let cancellationError: Error | undefined;
  const offlineQueries: string[][] = [];
  const port: PlanDeviceLossPort = {
    timer,
    getDevice: (id) => devices.get(id) ?? null,
    getPlanSessionUuid: (id) => id,
    hasPlanExecution: () => true,
    getPlanExecutionIds: () => [],
    isStartupLeased: () => false,
    isShutdownReserved: async () => false,
    discover: async () => discovery,
    getOfflineDeviceIds: async (ids) => {
      offlineQueries.push([...ids]);
      if (offlineFailure) {
        throw new Error("adb unavailable");
      }
      return new Set();
    },
    isTransportRestarting: () => {
      throw new Error("Android-only evidence");
    },
    isAdbReset: () => adbReset,
    recordLoss: async (id) => {
      lost.push(id);
      return "incident";
    },
    finishLoss: async (id) => {
      finished.push(id);
    },
    cancelPlan: async (id) => {
      cancelled.push(id);
      if (cancellationError) {
        throw cancellationError;
      }
      return 1;
    },
  };
  const monitor = new PlanDeviceLossMonitor(port);
  return {
    timer,
    ios,
    android,
    lost,
    cancelled,
    finished,
    offlineQueries,
    check: (ids = [ios.id]) => monitor.check(ids, new Set()),
    set discovery(value: BootedDeviceDiscovery) {
      discovery = value;
    },
    set adbReset(value: boolean) {
      adbReset = value;
    },
    set cancellationError(value: Error) {
      cancellationError = value;
    },
    set offlineFailure(value: boolean) {
      offlineFailure = value;
    },
  };
}

describe("PlanDeviceLossMonitor simulator evidence", () => {
  test("an unexpected cancellation failure still finishes the captured incident", async () => {
    const h = harness();
    h.cancellationError = new Error("cancellation failed");
    await h.check();
    h.timer.setCurrentTime(PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS);
    await expect(h.check()).rejects.toThrow("cancellation failed");
    expect(h.finished).toEqual(["incident"]);
  });

  test("iOS absence waits the full window and ignores unavailable adb", async () => {
    const h = harness();
    h.offlineFailure = true;
    await h.check();
    h.timer.setCurrentTime(PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS - 1);
    await h.check();
    expect(h.lost).toEqual([]);
    h.timer.setCurrentTime(PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS);
    await h.check();
    expect(h.lost).toEqual([h.ios.id]);
    expect(h.cancelled).toEqual([h.ios.id]);
    expect(h.finished).toEqual(["incident"]);
    expect(h.offlineQueries).toEqual([]);
  });

  test.each(["failed-simctl", "present"])(
    "%s breaks the simulator absence window",
    async (evidence) => {
      const h = harness();
      await h.check();
      h.timer.setCurrentTime(PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS);
      h.discovery = {
        devices:
          evidence === "present" ? [{ deviceId: h.ios.id, platform: "ios", name: "iPhone" }] : [],
        succeededPlatforms: new Set(["android", "ios"]),
        succeededSources: new Set(evidence === "present" ? ["ios-simulator"] : ["ios-physical"]),
      };
      await h.check();
      expect(h.lost).toEqual([]);
      h.discovery = {
        devices: [],
        succeededPlatforms: new Set(["ios"]),
        succeededSources: new Set(["ios-simulator"]),
      };
      await h.check();
      expect(h.lost).toEqual([]);
      h.timer.setCurrentTime(2 * PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS);
      await h.check();
      expect(h.lost).toEqual([h.ios.id]);
    },
  );

  test.each(["reset", "failed-probe"])(
    "ADB %s defers Android while simctl confirms iOS",
    async (evidence) => {
      const h = harness();
      h.adbReset = evidence === "reset";
      h.offlineFailure = evidence === "failed-probe";
      await h.check([h.ios.id, h.android.id]);
      h.timer.setCurrentTime(PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS);
      await h.check([h.ios.id, h.android.id]);
      expect(h.lost).toEqual([h.ios.id]);
      expect(h.offlineQueries).toEqual([[h.android.id], [h.android.id]]);
    },
  );
});
