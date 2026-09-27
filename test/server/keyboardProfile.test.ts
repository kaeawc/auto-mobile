import { expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import {
  keyboardSchema,
  listKeyboardProfilesForTool,
  setKeyboardProfileForTool,
} from "../../src/server/interactionTools";

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
