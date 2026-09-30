import { describe, expect, test } from "bun:test";
import {
  DeviceRecoveryCoordinator,
  type DeviceRecoveryPoolPort,
} from "../../src/daemon/deviceRecoveryCoordinator";
import type { AndroidRecoveryRecord } from "../../src/daemon/androidRecoveryRecordLedger";
import { FakeTimer } from "../fakes/FakeTimer";

function harness() {
  const timer = new FakeTimer();
  const records = new Map<string, AndroidRecoveryRecord>();
  const port: DeviceRecoveryPoolPort = {
    getRecoveringSessionLosses: () => records,
    getTimer: () => timer,
  };
  return { coordinator: new DeviceRecoveryCoordinator(port), records, timer };
}

const image = { name: "Pixel", platform: "android" as const, isRunning: false };

describe("DeviceRecoveryCoordinator", () => {
  test("image settlement releases a waiting startup and keeps the same promise on duplicate set", async () => {
    const { coordinator } = harness();
    coordinator.setRecoveringAndroidImage("Pixel", image);
    let settled = false;
    const waiting = coordinator.waitForRecoveringAndroidImages(["Pixel"]).then(() => {
      settled = true;
    });
    coordinator.setRecoveringAndroidImage("Pixel", image);
    await Promise.resolve();
    expect(settled).toBe(false);
    coordinator.clearRecoveringAndroidImage("Pixel");
    await waiting;
    expect(settled).toBe(true);
    expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);
  });

  test("finish drops only its owner and retains an image reserved by a live record", () => {
    const { coordinator, records } = harness();
    const own = Symbol("own");
    const other = Symbol("other");
    coordinator.setRecoveringAndroidImage("Pixel", image);
    coordinator.addRecoveringAndroidDeviceId("emulator-5554");
    coordinator.setAndroidRecoveryHandoffOwner("emulator-5554", own);
    coordinator.setAndroidRecoveryHandoffOwner("emulator-5556", other);
    records.set("session", {
      sessionId: "session",
      generation: 1,
      deviceId: "emulator-5554",
      avdName: "Pixel",
      deferredShutdowns: 0,
      state: "pending",
      reservations: new Set(["image"]),
    });
    coordinator.finishAndroidRecoveryAttempt("Pixel", new Set(["emulator-5554"]), false, own);
    expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(true);
    expect(coordinator.recoveringAndroidDeviceIds.has("emulator-5554")).toBe(false);
    expect(coordinator.isAndroidRecoveryHandoffReserved("emulator-5554")).toBe(false);
    expect(coordinator.isAndroidRecoveryHandoffReserved("emulator-5556")).toBe(true);
    expect(coordinator.isAndroidRecoveryHandoffReserved("emulator-5556", new Set([other]))).toBe(
      false,
    );
    records.clear();
    coordinator.finishAndroidRecoveryAttempt("Pixel", new Set(), false, other);
    expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);
  });

  test("aborted settlement wait preserves its rejection reason and removes its listener", async () => {
    const { coordinator } = harness();
    coordinator.setRecoveringAndroidImage("Pixel", image);
    const abort = new AbortController();
    const reason = new Error("cancelled");
    const waiting = coordinator.waitForRecoveringAndroidImages(["Pixel"], abort.signal);
    abort.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    coordinator.clearRecoveringAndroidImage("Pixel");
  });

  test("an untracked image waits one FakeTimer retry and returns", async () => {
    const { coordinator, timer } = harness();
    coordinator.recoveringAndroidImages.set("Pixel", image);
    const waiting = coordinator.waitForRecoveringAndroidImages(["Pixel"]);
    expect(timer.getSleepHistory()).toEqual([250]);
    timer.advanceTime(250);
    await waiting;
  });
});
