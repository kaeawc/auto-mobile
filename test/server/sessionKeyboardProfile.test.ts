import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { registerKeyboardProfileSessionCleanup } from "../../src/daemon/keyboardProfileSessionCleanup";
import { KeyboardProfileRestoreRegistry } from "../../src/features/action/KeyboardProfileRestore";
import type { KeyboardProfileId } from "../../src/features/action/keyboardProfiles";
import type { BootedDevice } from "../../src/models";
import { setKeyboardProfileForSession } from "../../src/server/sessionKeyboardProfile";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

describe("keyboard setProfile records the profile it replaced (#14705)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let registry: KeyboardProfileRestoreRegistry;
  let active: string;
  let sets: string[];

  const setProfile = async (_device: BootedDevice, profile: KeyboardProfileId | undefined) => {
    const previousProfileId = active;
    active = profile as string;
    sets.push(active);
    return { activeProfileId: active, previousProfileId };
  };

  const set = (profile: KeyboardProfileId, sessionUuid?: string) =>
    setKeyboardProfileForSession(emulator, profile, sessionUuid, {
      sessionManager: () => manager,
      registry,
      setProfile,
    });

  beforeEach(() => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    registry = new KeyboardProfileRestoreRegistry();
    active = "gboard";
    sets = [];
    registerKeyboardProfileSessionCleanup(manager, {
      registry,
      setProfile: (device, profile) => setProfile(device, profile),
      timer,
    });
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("a session's change is restored to the profile before its first change when it is released", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    expect(await set("samsung", "session-1")).toMatchObject({
      previousProfileId: "gboard",
      restoresOnRelease: true,
    });
    await set("direct", "session-1");

    await manager.releaseSession("session-1");
    await timer.resolveAll();

    expect(active).toBe("gboard");
    expect(registry.recorded(emulator.deviceId)).toBeUndefined();
  });

  test("a sessionless change persists and is not restored by a release", async () => {
    expect(await set("samsung")).toMatchObject({ restoresOnRelease: false });
    await manager.createSession("session-1", emulator.deviceId, "android");
    await manager.releaseSession("session-1");
    await timer.resolveAll();
    expect(active).toBe("samsung");
    expect(sets).toEqual(["samsung"]);
  });

  test("a session bound to another device is refused before anything changes", async () => {
    await manager.createSession("session-1", "emulator-5556", "android");
    await expect(set("samsung", "session-1")).rejects.toThrow("Cannot change the keyboard profile");
    expect(sets).toEqual([]);
  });
});
