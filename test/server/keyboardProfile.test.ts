import { expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { keyboardSchema, setKeyboardProfileForTool } from "../../src/server/interactionTools";

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
