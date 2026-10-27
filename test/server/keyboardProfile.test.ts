import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerKeyboardProfileSessionCleanup } from "../../src/daemon/keyboardProfileSessionCleanup";
import { SessionManager } from "../../src/daemon/sessionManager";
import { KeyboardProfileRestoreRegistry } from "../../src/features/utility/KeyboardProfileRestore";
import type { BootedDevice } from "../../src/models";
import { keyboardSchema } from "../../src/server/interactionTools";
import { setKeyboardProfileRecorded } from "../../src/features/utility/KeyboardProfileRestore";
import {
  createKeyboardHandler,
  listKeyboardProfilesForTool,
  resetKeyboardProfileForTool,
  setKeyboardProfileForTool,
} from "../../src/server/interactionToolHandlers";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const androidDevice = { deviceId: "device", platform: "android", name: "Device" } as BootedDevice;
const iosDevice = { deviceId: "simulator", platform: "ios", name: "Simulator" } as BootedDevice;

test("keyboard schema accepts supported profiles", () => {
  expect(
    keyboardSchema.safeParse({ action: "setProfile", profile: "gboard", platform: "android" })
      .success,
  ).toBe(true);
  expect(
    keyboardSchema.safeParse({ action: "setProfile", profile: "unknown", platform: "android" })
      .success,
  ).toBe(false);
});

test("keyboard schema exposes installed-IME discovery separately from behavior profiles", () => {
  expect(keyboardSchema.safeParse({ action: "listProfiles", platform: "android" }).success).toBe(
    true,
  );
  expect(keyboardSchema.safeParse({ action: "listImes", platform: "android" }).success).toBe(true);
  expect(
    keyboardSchema.safeParse({
      action: "setIme",
      imeId: "com.example/.Keyboard",
      platform: "android",
    }).success,
  ).toBe(true);
  expect(
    keyboardSchema.safeParse({
      action: "tapImeKey",
      imeId: "com.example/.Keyboard",
      key: "a",
      platform: "android",
    }).success,
  ).toBe(true);
});

test("listProfiles negotiates a versioned AutoMobile behavior catalog", async () => {
  const calls: string[] = [];
  const catalog = {
    success: true,
    catalogId: "automobile_behavior_profiles",
    catalogVersion: 1,
    supportedCatalogVersions: [1],
    activeProfileId: "gboard",
    profiles: [
      {
        id: "gboard",
        displayName: "Gboard",
        version: 1,
        evidenceStatus: "focused_trace" as const,
        evidenceNote: "Focused trace comparison; full vendor equivalence is not claimed.",
        behavior: {
          composeWords: true,
          enterStrategy: "KEY_EVENT" as const,
          backspaceStrategy: "DELETE_SURROUNDING" as const,
          recomposeOnCursorMove: false,
          recomposeOnBackspaceIntoWord: true,
          batchEdits: true,
        },
      },
    ],
  };
  const client = {
    supportsCommand: async (command: string) => {
      calls.push(command);
      return true;
    },
    listKeyboardProfiles: async () => {
      calls.push("list");
      return catalog;
    },
  };

  expect(await listKeyboardProfilesForTool(androidDevice, client)).toEqual(catalog);
  expect(calls).toEqual(["request_list_keyboard_profiles", "list"]);
  expect(catalog).not.toHaveProperty("imeId");
});

test("listProfiles rejects unsupported catalog versions and older proxy builds", async () => {
  const client = {
    supportsCommand: async () => true,
    listKeyboardProfiles: async () => ({
      success: true,
      catalogId: "automobile_behavior_profiles",
      catalogVersion: 2,
      profiles: [],
    }),
  };
  await expect(listKeyboardProfilesForTool(androidDevice, client)).rejects.toThrow(
    "Unsupported keyboard profile catalog version",
  );
  await expect(
    listKeyboardProfilesForTool(androidDevice, {
      supportsCommand: async () => false,
      listKeyboardProfiles: async () => {
        throw new Error("must not send");
      },
    }),
  ).rejects.toThrow("update/re-cut the APK");
});

test("setProfile validates profile and platform before calling the client", async () => {
  const calls: string[] = [];
  const client = {
    supportsCommand: async () => {
      calls.push("supports");
      return true;
    },
    setKeyboardProfile: async () => {
      calls.push("set");
      return { success: true };
    },
  };
  await expect(setKeyboardProfileForTool(androidDevice, undefined, client)).rejects.toThrow(
    "requires profile",
  );
  await expect(setKeyboardProfileForTool(iosDevice, "direct", client)).rejects.toThrow(
    "Android-only",
  );
  expect(calls).toEqual([]);
});

test("setProfile negotiates then returns profile ids", async () => {
  const calls: string[] = [];
  const client = {
    supportsCommand: async (command: string) => {
      calls.push(command);
      return true;
    },
    setKeyboardProfile: async (id: string) => {
      calls.push(id);
      return { success: true, activeProfileId: id, previousProfileId: "direct" };
    },
  };
  expect(await setKeyboardProfileForTool(androidDevice, "gboard", client)).toEqual({
    activeProfileId: "gboard",
    previousProfileId: "direct",
  });
  expect(calls).toEqual(["request_set_keyboard_profile", "gboard"]);
});

test("setProfile fails closed on an older build", async () => {
  const calls: string[] = [];
  const client = {
    supportsCommand: async () => false,
    setKeyboardProfile: async () => {
      calls.push("set");
      return { success: true };
    },
  };
  await expect(setKeyboardProfileForTool(androidDevice, "direct", client)).rejects.toThrow(
    "update/re-cut the APK",
  );
  expect(calls).toEqual([]);
});

/** A CtrlProxy that tracks the active keyboard profile the way KeyboardProfileStore persists it. */
class FakeKeyboardProfileProxy {
  active = "direct";
  readonly writes: string[] = [];
  refuse = false;

  async supportsCommand(): Promise<boolean> {
    return true;
  }

  async setKeyboardProfile(profileId: string) {
    this.writes.push(profileId);
    if (this.refuse) {
      return { success: false, error: "CtrlProxy refused" };
    }
    const previousProfileId = this.active;
    this.active = profileId;
    return { success: true, activeProfileId: profileId, previousProfileId };
  }
}

describe("keyboard profile restore record (#14705)", () => {
  let proxy: FakeKeyboardProfileProxy;
  let registry: KeyboardProfileRestoreRegistry;

  beforeEach(() => {
    proxy = new FakeKeyboardProfileProxy();
    registry = new KeyboardProfileRestoreRegistry();
  });

  test("setProfile records the profile before the first change for its owner", async () => {
    await setKeyboardProfileForTool(androidDevice, "gboard", proxy, undefined, {
      owner: "session-1",
      registry,
    });
    await setKeyboardProfileForTool(androidDevice, "samsung", proxy, undefined, {
      owner: "session-1",
      registry,
    });
    expect(registry.pending(androidDevice.deviceId)).toBe("direct");
    expect(registry.takeOwnedBy(androidDevice.deviceId, "session-1")?.profileId).toBe("direct");
  });

  test("a refused setProfile records nothing", async () => {
    proxy.refuse = true;
    await expect(
      setKeyboardProfileForTool(androidDevice, "gboard", proxy, undefined, { registry }),
    ).rejects.toThrow("CtrlProxy refused");
    expect(registry.pending(androidDevice.deviceId)).toBeUndefined();
  });

  test("reset puts the recorded profile back once and keeps a refused one recorded", async () => {
    await setKeyboardProfileForTool(androidDevice, "gboard", proxy, undefined, { registry });
    proxy.refuse = true;
    await expect(
      resetKeyboardProfileForTool(androidDevice, proxy, undefined, registry),
    ).rejects.toThrow("CtrlProxy refused");
    expect(registry.pending(androidDevice.deviceId)).toBe("direct");

    proxy.refuse = false;
    expect(await resetKeyboardProfileForTool(androidDevice, proxy, undefined, registry)).toEqual({
      restoredProfileId: "direct",
    });
    expect(proxy.active).toBe("direct");
    proxy.writes.length = 0;
    expect(await resetKeyboardProfileForTool(androidDevice, proxy, undefined, registry)).toEqual(
      {},
    );
    expect(proxy.writes).toEqual([]);
  });
});

describe("keyboard setProfile in a daemon session (#14705)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let proxy: FakeKeyboardProfileProxy;
  let registry: KeyboardProfileRestoreRegistry;
  let handler: ReturnType<typeof createKeyboardHandler>;

  beforeEach(() => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    proxy = new FakeKeyboardProfileProxy();
    registry = new KeyboardProfileRestoreRegistry();
    registerKeyboardProfileSessionCleanup(manager, { registry, clientFor: () => proxy, timer });
    handler = createKeyboardHandler({
      keyboardProfile: { sessionManager: () => manager, clientFor: () => proxy, registry },
    });
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("release puts back the profile active before the session's first change", async () => {
    await manager.createSession("session-1", androidDevice.deviceId, "android");
    for (const profile of ["gboard", "samsung"] as const) {
      await handler(androidDevice, { action: "setProfile", profile, sessionUuid: "session-1" });
    }
    expect(proxy.active).toBe("samsung");

    await manager.releaseSession("session-1", "explicit-release");
    await manager.getPendingDeviceCleanup(androidDevice.deviceId);
    expect(proxy.active).toBe("direct");
    expect(registry.pending(androidDevice.deviceId)).toBeUndefined();
  });

  test("a sessionless change persists after another session's release", async () => {
    await manager.createSession("session-1", androidDevice.deviceId, "android");
    await handler(androidDevice, { action: "setProfile", profile: "gboard" });
    await manager.releaseSession("session-1", "explicit-release");
    await manager.getPendingDeviceCleanup(androidDevice.deviceId);
    expect(proxy.active).toBe("gboard");
    expect(proxy.writes).toEqual(["gboard"]);
  });

  test("a released session cannot change the profile", async () => {
    await manager.createSession("session-1", androidDevice.deviceId, "android");
    await manager.releaseSession("session-1", "explicit-release");
    await expect(
      handler(androidDevice, { action: "setProfile", profile: "gboard", sessionUuid: "session-1" }),
    ).rejects.toThrow("Cannot change the keyboard profile");
    expect(proxy.writes).toEqual([]);
  });
  test("a session bound to another device is refused before anything changes", async () => {
    await manager.createSession("session-1", "other-device", "android");
    await expect(
      handler(androidDevice, { action: "setProfile", profile: "gboard", sessionUuid: "session-1" }),
    ).rejects.toThrow("Cannot change the keyboard profile");
    expect(proxy.writes).toEqual([]);
  });

  test("an acquisition-time manufacturer-profile write is restored by the same release path", async () => {
    await manager.createSession("session-1", androidDevice.deviceId, "android");
    await setKeyboardProfileRecorded(androidDevice, "samsung", proxy, undefined, {
      owner: "session-1",
      registry,
    });
    expect(proxy.active).toBe("samsung");

    await manager.releaseSession("session-1", "explicit-release");
    await manager.getPendingDeviceCleanup(androidDevice.deviceId);
    expect(proxy.active).toBe("direct");
    expect(registry.pending(androidDevice.deviceId)).toBeUndefined();
  });
});
