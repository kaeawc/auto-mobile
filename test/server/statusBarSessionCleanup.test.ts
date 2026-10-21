import { beforeEach, describe, expect, test } from "bun:test";
import {
  forgetStatusBarOverrideForRemovedDevice,
  registerStatusBarSessionCleanup,
} from "../../src/daemon/statusBarSessionCleanup";
import { StatusBarOverrideRegistry } from "../../src/features/utility/StatusBarOverrideRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeStatusBarController } from "../fakes/FakeStatusBarController";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";

const DEVICE: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

describe("registerStatusBarSessionCleanup (#14105)", () => {
  let registry: StatusBarOverrideRegistry;
  let manager: FakeSessionCleanupManager;
  let controller: FakeStatusBarController;
  let timer: FakeTimer;

  beforeEach(() => {
    registry = new StatusBarOverrideRegistry();
    manager = new FakeSessionCleanupManager();
    controller = new FakeStatusBarController();
    timer = new FakeTimer();
    registerStatusBarSessionCleanup(manager, {
      registry,
      controllerFor: () => controller,
      timer,
    });
  });

  test("releasing the owning session clears the override as pending device cleanup", async () => {
    registry.record(DEVICE, "session-1", { time: "9:41" });
    manager.release("session-1", DEVICE.deviceId);
    expect(manager.pendingCleanups.map((entry) => entry.deviceId)).toEqual([DEVICE.deviceId]);
    await manager.settle();
    expect(controller.clears).toBe(1);
    expect(registry.get(DEVICE.deviceId)).toBeNull();
  });

  test("moving off the device clears the override too", async () => {
    registry.record(DEVICE, "session-1", { batteryLevel: 100 });
    manager.unbound("session-1", DEVICE.deviceId);
    await manager.settle();
    expect(controller.clears).toBe(1);
  });

  test("another session's release, a sessionless override and an upgrade-only release clear nothing", async () => {
    registry.record(DEVICE, "session-1", { time: "9:41" });
    manager.release("session-2", DEVICE.deviceId);
    manager.release("session-1", DEVICE.deviceId, true);
    registry.record({ ...DEVICE, deviceId: "emulator-5556" }, null, { time: "9:41" });
    manager.release("session-1", "emulator-5556");
    await manager.settle();
    expect(controller.clears).toBe(0);
    expect(manager.pendingCleanups).toEqual([]);
    expect(registry.get(DEVICE.deviceId)?.sessionId).toBe("session-1");
  });

  test("an identity replacement forgets the override without touching the device", () => {
    registry.record(DEVICE, "session-1", { time: "9:41" });
    manager.release("session-1", DEVICE.deviceId, false, true);
    expect(controller.clears).toBe(0);
    expect(manager.pendingCleanups).toEqual([]);
    expect(registry.get(DEVICE.deviceId)).toBeNull();
  });

  test("a failed clear settles the cleanup instead of rejecting it", async () => {
    controller.clearError = new Error("adb offline");
    registry.record(DEVICE, "session-1", { time: "9:41" });
    manager.release("session-1", DEVICE.deviceId);
    await expect(manager.pendingCleanups[0]!.cleanup).resolves.toBeUndefined();
  });

  test("an unanswered clear is aborted at the ten-second release cap", async () => {
    controller.hangClear = true;
    registry.record(DEVICE, "session-1", { time: "9:41" });
    manager.release("session-1", DEVICE.deviceId);
    let settled = false;
    void manager.pendingCleanups[0]!.cleanup.then(() => {
      settled = true;
    });
    timer.advanceTime(9_999);
    expect(controller.lastClearSignal?.aborted).toBe(false);
    timer.advanceTime(1);
    await drainUntil(() => settled, { description: "status bar clear cap" });
    expect(controller.lastClearSignal?.aborted).toBe(true);
  });

  test("device removal forgets the override", () => {
    registry.record(DEVICE, "session-1", { time: "9:41" });
    forgetStatusBarOverrideForRemovedDevice(DEVICE.deviceId, registry);
    expect(registry.get(DEVICE.deviceId)).toBeNull();
  });
});

describe("StatusBarOverrideRegistry", () => {
  test("the same owner merges fields; a different owner replaces them", () => {
    const registry = new StatusBarOverrideRegistry();
    registry.record(DEVICE, "session-1", { time: "9:41" });
    registry.record(DEVICE, "session-1", { batteryLevel: 50 });
    expect(registry.get(DEVICE.deviceId)?.overrides).toEqual({ time: "9:41", batteryLevel: 50 });
    registry.record(DEVICE, "session-2", { wifiBars: 1 });
    expect(registry.get(DEVICE.deviceId)).toEqual({
      device: DEVICE,
      sessionId: "session-2",
      overrides: { wifiBars: 1 },
    });
    expect(registry.takeOwnedBy(DEVICE.deviceId, "session-1")).toBeNull();
    expect(registry.takeOwnedBy(DEVICE.deviceId, "session-2")?.sessionId).toBe("session-2");
    expect(registry.get(DEVICE.deviceId)).toBeNull();
  });
});
