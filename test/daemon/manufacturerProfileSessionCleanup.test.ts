import { beforeEach, describe, expect, test } from "bun:test";
import {
  registerManufacturerProfileSessionCleanup,
  type KeyboardProfileSetter,
} from "../../src/daemon/manufacturerProfileSessionCleanup";
import { PersonaRestoreRegistry } from "../../src/features/utility/PersonaRestore";
import type { BootedDevice } from "../../src/models";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

describe("registerManufacturerProfileSessionCleanup (#14058)", () => {
  let registry: PersonaRestoreRegistry;
  let manager: FakeSessionCleanupManager;
  let restored: Array<{ deviceId: string; profile: string }>;
  let keyboardError: Error | undefined;

  beforeEach(() => {
    registry = new PersonaRestoreRegistry();
    manager = new FakeSessionCleanupManager();
    restored = [];
    keyboardError = undefined;
    const setKeyboard: KeyboardProfileSetter = async (device, profile) => {
      if (keyboardError) {
        throw keyboardError;
      }
      restored.push({ deviceId: device.deviceId, profile });
    };
    registerManufacturerProfileSessionCleanup(manager, {
      registry,
      setKeyboard,
      timer: new FakeTimer(),
    });
  });

  const acquire = (sessionId: string) =>
    registry.recordApply(emulator.deviceId, "samsung-oneui", {
      keyboardProfileBefore: "gboard",
      releaseOwner: { sessionId, device: emulator },
    });

  test("release restores the keyboard the session's profile changed, once", async () => {
    acquire("session-1");

    manager.release("session-1", emulator.deviceId);

    expect(manager.pendingCleanups).toHaveLength(1);
    expect(manager.pendingCleanups[0].bound).toMatchObject({
      name: "restore manufacturer profile keyboard",
    });
    expect(await manager.pendingCleanups[0].cleanup).toBe(true);
    expect(restored).toEqual([{ deviceId: emulator.deviceId, profile: "gboard" }]);
    manager.release("session-1", emulator.deviceId);
    expect(manager.pendingCleanups).toHaveLength(1);
  });

  test("rebinding off the device restores like a release", async () => {
    acquire("session-1");
    manager.unbound("session-1", emulator.deviceId);
    await manager.settle();
    expect(restored).toEqual([{ deviceId: emulator.deviceId, profile: "gboard" }]);
  });

  test("another session's release, a terminal upgrade and tool-path applies restore nothing", () => {
    registry.recordApply(emulator.deviceId, "samsung-oneui", { keyboardProfileBefore: "gboard" });
    manager.release("session-1", emulator.deviceId);
    acquire("session-2");
    manager.release("session-1", emulator.deviceId);
    manager.release("session-2", emulator.deviceId, true);
    expect(manager.pendingCleanups).toEqual([]);
  });

  test("a replaced serial drops the record without writing to the new device", () => {
    acquire("session-1");
    manager.release("session-1", emulator.deviceId, false, true);
    expect(manager.pendingCleanups).toEqual([]);
    expect(restored).toEqual([]);
    expect(registry.get(emulator.deviceId)).toBeUndefined();
  });

  test("a refused restore is reported as not restored", async () => {
    acquire("session-1");
    keyboardError = new Error("control proxy unavailable");
    manager.release("session-1", emulator.deviceId);
    expect(await manager.pendingCleanups[0].cleanup).toBe(false);
  });
});
