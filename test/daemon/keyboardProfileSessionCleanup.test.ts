import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { registerKeyboardProfileSessionCleanup } from "../../src/daemon/keyboardProfileSessionCleanup";
import { withAndroidImeLock } from "../../src/features/action/androidImeLock";
import {
  KEYBOARD_PROFILE_RESTORE_TIMEOUT_MS,
  KeyboardProfileRestoreRegistry,
  type KeyboardProfileClient,
} from "../../src/features/utility/KeyboardProfileRestore";
import type { BootedDevice } from "../../src/models";
import { logger } from "../../src/utils/logger";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

type SetKeyboardProfileResult = Awaited<ReturnType<KeyboardProfileClient["setKeyboardProfile"]>>;

/** A CtrlProxy keyboard-profile client that records each write and answers as scripted. */
class FakeKeyboardProfileClient implements KeyboardProfileClient {
  readonly writes: string[] = [];
  next: () => Promise<SetKeyboardProfileResult> = async () => ({ success: true });

  setKeyboardProfile(profileId: string): Promise<SetKeyboardProfileResult> {
    this.writes.push(profileId);
    return this.next();
  }
}

describe("registerKeyboardProfileSessionCleanup (#14705)", () => {
  let client: FakeKeyboardProfileClient;
  let registry: KeyboardProfileRestoreRegistry;
  let manager: FakeSessionCleanupManager;
  let timer: FakeTimer;

  beforeEach(() => {
    client = new FakeKeyboardProfileClient();
    registry = new KeyboardProfileRestoreRegistry();
    manager = new FakeSessionCleanupManager();
    timer = new FakeTimer();
    registerKeyboardProfileSessionCleanup(manager, {
      registry,
      clientFor: () => client,
      timer,
    });
  });

  test("release restores the profile active before the session's first change, once", async () => {
    registry.record(emulator, "direct", "session-1");
    registry.record(emulator, "gboard", "session-1");

    manager.release("session-1", emulator.deviceId);

    expect(manager.pendingCleanups).toHaveLength(1);
    expect(manager.pendingCleanups[0].bound).toMatchObject({ name: "restore keyboard profile" });
    expect(await manager.pendingCleanups[0].cleanup).toBe(true);
    expect(client.writes).toEqual(["direct"]);
    expect(registry.pending(emulator.deviceId)).toBeUndefined();
    manager.release("session-1", emulator.deviceId);
    expect(manager.pendingCleanups).toHaveLength(1);
  });

  test("rebinding off the device restores like a release", async () => {
    registry.record(emulator, "samsung", "session-1");
    manager.unbound("session-1", emulator.deviceId);
    await manager.settle();
    expect(client.writes).toEqual(["samsung"]);
  });

  test("another session's release, a terminal upgrade and sessionless changes restore nothing", () => {
    registry.record(emulator, "direct", undefined);
    manager.release("session-1", emulator.deviceId);
    expect(registry.pending(emulator.deviceId)).toBe("direct");
    registry.retireDevice(emulator.deviceId);
    registry.record(emulator, "direct", "session-2");
    manager.release("session-1", emulator.deviceId);
    manager.release("session-2", emulator.deviceId, true);
    expect(manager.pendingCleanups).toEqual([]);
    expect(client.writes).toEqual([]);
  });

  test("a replaced serial drops the record without writing to the new device", () => {
    registry.record(emulator, "direct", "session-1");
    manager.release("session-1", emulator.deviceId, false, true);
    expect(manager.pendingCleanups).toEqual([]);
    expect(client.writes).toEqual([]);
    expect(registry.pending(emulator.deviceId)).toBeUndefined();
  });

  test("a restore CtrlProxy refuses is logged and does not block the release", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      client.next = async () => ({ success: false, error: "unknown profile" });
      registry.record(emulator, "direct", "session-1");
      manager.release("session-1", emulator.deviceId);
      expect(await manager.pendingCleanups[0].cleanup).toBe(false);
      expect(warn.mock.calls[0]?.[0]).toContain("Failed to restore keyboard profile direct");
      expect(warn.mock.calls[0]?.[0]).toContain("unknown profile");
    } finally {
      warn.mockRestore();
    }
  });

  test("a restore that cannot finish is bounded, and one still waiting for the IME lock gives up", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    let releaseLock!: () => void;
    const held = withAndroidImeLock(
      emulator.deviceId,
      () => new Promise<void>((resolve) => (releaseLock = resolve)),
    );
    try {
      registry.record(emulator, "direct", "session-1");
      manager.release("session-1", emulator.deviceId);
      const restored = manager.pendingCleanups[0].cleanup;

      timer.advanceTime(KEYBOARD_PROFILE_RESTORE_TIMEOUT_MS);
      expect(await restored).toBe(false);
      expect(warn.mock.calls[0]?.[0]).toContain("timed out");

      releaseLock();
      await held;
      await withAndroidImeLock(emulator.deviceId, async () => {});
      expect(client.writes).toEqual([]);
    } finally {
      releaseLock?.();
      warn.mockRestore();
    }
  });
});

describe("KeyboardProfileRestoreRegistry (#14705)", () => {
  test("records the profile before the first change once; a session takes ownership", () => {
    const registry = new KeyboardProfileRestoreRegistry();
    expect(registry.record(emulator, "direct", undefined)).toBe(true);
    expect(registry.takeOwnedBy(emulator.deviceId, "session-1")).toBeUndefined();
    expect(registry.record(emulator, "gboard", "session-1")).toBe(false);
    expect(registry.pending(emulator.deviceId)).toBe("direct");
    expect(registry.takeOwnedBy(emulator.deviceId, "session-2")).toBeUndefined();
    expect(registry.takeOwnedBy(emulator.deviceId, "session-1")).toEqual({
      device: emulator,
      profileId: "direct",
    });
    expect(registry.pending(emulator.deviceId)).toBeUndefined();
  });

  test("forget and retireDevice drop the record", () => {
    const registry = new KeyboardProfileRestoreRegistry();
    registry.record(emulator, "direct", "session-1");
    registry.forget(emulator.deviceId);
    expect(registry.takeOwnedBy(emulator.deviceId, "session-1")).toBeUndefined();
    registry.record(emulator, "samsung", undefined);
    registry.retireDevice(emulator.deviceId);
    expect(registry.pending(emulator.deviceId)).toBeUndefined();
  });
});
