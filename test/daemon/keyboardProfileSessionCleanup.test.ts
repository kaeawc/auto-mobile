import { beforeEach, describe, expect, test } from "bun:test";
import { registerKeyboardProfileSessionCleanup } from "../../src/daemon/keyboardProfileSessionCleanup";
import {
  KEYBOARD_PROFILE_RESTORE_TIMEOUT_MS,
  KeyboardProfileRestoreRegistry,
  type KeyboardProfileSetter,
} from "../../src/features/action/KeyboardProfileRestore";
import type { BootedDevice } from "../../src/models";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

describe("registerKeyboardProfileSessionCleanup (#14705)", () => {
  let registry: KeyboardProfileRestoreRegistry;
  let manager: FakeSessionCleanupManager;
  let timer: FakeTimer;
  let sets: string[];
  let setProfile: KeyboardProfileSetter;

  beforeEach(() => {
    registry = new KeyboardProfileRestoreRegistry();
    manager = new FakeSessionCleanupManager();
    timer = new FakeTimer();
    sets = [];
    setProfile = async (device, profile) => {
      sets.push(`${device.deviceId}:${profile}`);
    };
    registerKeyboardProfileSessionCleanup(manager, {
      registry,
      setProfile: (device, profile, signal) => setProfile(device, profile, signal),
      timer,
    });
  });

  test("release restores the profile active before the session's first change, once", async () => {
    registry.record(emulator, "gboard", "session-1");
    registry.record(emulator, "samsung", "session-1");

    manager.release("session-1", emulator.deviceId);

    expect(manager.pendingCleanups).toHaveLength(1);
    expect(manager.pendingCleanups[0].bound).toMatchObject({ name: "restore keyboard profile" });
    expect(await manager.pendingCleanups[0].cleanup).toBe(true);
    expect(sets).toEqual(["emulator-5554:gboard"]);
    manager.release("session-1", emulator.deviceId);
    expect(manager.pendingCleanups).toHaveLength(1);
  });

  test("rebinding off the device restores like a release", async () => {
    registry.record(emulator, "direct", "session-1");
    manager.unbound("session-1", emulator.deviceId);
    await manager.settle();
    expect(sets).toEqual(["emulator-5554:direct"]);
  });

  test("a sessionless change, another session's release and a terminal upgrade restore nothing", () => {
    registry.record(emulator, "gboard", undefined);
    manager.release("session-1", emulator.deviceId);
    expect(registry.recorded(emulator.deviceId)).toBe("gboard");

    registry.retireDevice(emulator.deviceId);
    registry.record(emulator, "gboard", "session-2");
    manager.release("session-1", emulator.deviceId);
    manager.release("session-2", emulator.deviceId, true);
    expect(manager.pendingCleanups).toEqual([]);
  });

  test("a replaced serial drops the record without writing to the new device", () => {
    registry.record(emulator, "gboard", "session-1");
    manager.release("session-1", emulator.deviceId, false, true);
    expect(manager.pendingCleanups).toEqual([]);
    expect(registry.recorded(emulator.deviceId)).toBeUndefined();
    expect(sets).toEqual([]);
  });

  test("a failed restore is logged and resolves false instead of blocking release", async () => {
    setProfile = async () => {
      throw new Error("control proxy unreachable");
    };
    registry.record(emulator, "gboard", "session-1");
    manager.release("session-1", emulator.deviceId);
    expect(await manager.pendingCleanups[0].cleanup).toBe(false);
  });

  test("a restore that never answers is bounded and aborted, so it cannot land late", async () => {
    let restoreSignal: AbortSignal | undefined;
    setProfile = (_device, _profile, signal) => {
      restoreSignal = signal;
      return new Promise(() => {});
    };
    registry.record(emulator, "gboard", "session-1");
    manager.release("session-1", emulator.deviceId);
    const pending = manager.pendingCleanups[0].cleanup;
    timer.advanceTime(KEYBOARD_PROFILE_RESTORE_TIMEOUT_MS);
    expect(await pending).toBe(false);
    expect(restoreSignal?.aborted).toBe(true);
  });
});

describe("KeyboardProfileRestoreRegistry (#14705)", () => {
  test("records once per owner; a session's later changes keep its first before-profile", () => {
    const registry = new KeyboardProfileRestoreRegistry();
    registry.record(emulator, "gboard", "session-1");
    registry.record(emulator, "samsung", "session-1");
    registry.record(emulator, "direct", undefined);
    expect(registry.recorded(emulator.deviceId)).toBe("gboard");
    expect(registry.ownedRestoreTarget(emulator.deviceId, "session-1")).toBe("gboard");
    expect(registry.ownedRestoreTarget(emulator.deviceId, "session-2")).toBeUndefined();
    expect(registry.takeOwnedBy(emulator.deviceId, "session-2")).toBeUndefined();
    expect(registry.takeOwnedBy(emulator.deviceId, "session-1")).toEqual({
      device: emulator,
      before: "gboard",
    });
  });

  test("a session taking over a sessionless entry records its own before-profile", () => {
    const registry = new KeyboardProfileRestoreRegistry();
    registry.record(emulator, "gboard", undefined);
    expect(registry.restoresOnRelease(emulator.deviceId)).toBe(false);
    // The sessionless call set samsung; the session changes it from there.
    registry.record(emulator, "samsung", "session-1");
    expect(registry.restoresOnRelease(emulator.deviceId)).toBe(true);
    expect(registry.takeOwnedBy(emulator.deviceId, "session-1")?.before).toBe("samsung");
  });

  test("an unknown or missing previous profile records nothing", () => {
    const registry = new KeyboardProfileRestoreRegistry();
    registry.record(emulator, undefined, "session-1");
    registry.record(emulator, "honeyboard", "session-1");
    expect(registry.recorded(emulator.deviceId)).toBeUndefined();
  });
});
