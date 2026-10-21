import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { registerKeyboardProfileSessionCleanup } from "../../src/daemon/keyboardProfileSessionCleanup";
import { KeyboardProfileRestoreRegistry } from "../../src/features/action/KeyboardProfileRestore";
import type { KeyboardProfileId } from "../../src/features/action/keyboardProfiles";
import type { BootedDevice } from "../../src/models";
import { setKeyboardProfileForSession } from "../../src/server/sessionKeyboardProfile";
import { createKeyboardHandler } from "../../src/server/interactionToolHandlers";
import { keyboardSchema } from "../../src/server/interactionTools";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { SESSION_SETUP_DRAIN_TIMEOUT_MS } from "../../src/daemon/sessionManager/sessionConstants";

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

  test("a sessionless change survives a later session's release", async () => {
    await set("samsung");
    await manager.createSession("session-1", emulator.deviceId, "android");
    await set("direct", "session-1");
    await manager.releaseSession("session-1");
    await timer.resolveAll();
    expect(active).toBe("samsung");
  });

  test("a write that outlasts the release's setup drain is undone, not left behind", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    let slow = true;
    const slowSet = async (device: BootedDevice, profile: KeyboardProfileId | undefined) => {
      if (slow) {
        slow = false;
        await timer.sleep(SESSION_SETUP_DRAIN_TIMEOUT_MS * 2);
      }
      return setProfile(device, profile);
    };
    const pending = setKeyboardProfileForSession(emulator, "samsung", "session-1", {
      sessionManager: () => manager,
      registry,
      setProfile: slowSet,
    });
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    const release = manager.releaseSession("session-1");
    timer.advanceTime(SESSION_SETUP_DRAIN_TIMEOUT_MS);
    await release;
    timer.advanceTime(SESSION_SETUP_DRAIN_TIMEOUT_MS);
    expect(await outcome).toContain("was released or rebound while the keyboard profile changed");
    expect(active).toBe("gboard");
    expect(registry.recorded(emulator.deviceId)).toBeUndefined();
  });

  test("a session bound to another device is refused before anything changes", async () => {
    await manager.createSession("session-1", "emulator-5556", "android");
    await expect(set("samsung", "session-1")).rejects.toThrow("Cannot change the keyboard profile");
    expect(sets).toEqual([]);
  });
});

describe("keyboard tool setProfile in a session (#14705)", () => {
  test("the handler records the change under the session and reports restoresOnRelease", async () => {
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    try {
      await manager.createSession("session-1", emulator.deviceId, "android");
      const registry = new KeyboardProfileRestoreRegistry();
      const handler = createKeyboardHandler({
        keyboardProfile: {
          sessionManager: () => manager,
          registry,
          setProfile: async (_device, profile) => ({
            activeProfileId: profile,
            previousProfileId: "gboard",
          }),
        },
      });
      const response = await handler(
        emulator,
        keyboardSchema.parse({
          action: "setProfile",
          profile: "samsung",
          sessionUuid: "session-1",
        }),
      );
      expect((response as { structuredContent?: unknown }).structuredContent).toMatchObject({
        activeProfileId: "samsung",
        restoresOnRelease: true,
      });
      expect(registry.takeOwnedBy(emulator.deviceId, "session-1")?.before).toBe("gboard");
    } finally {
      manager.stopCleanupTimer();
    }
  });
});
