import { afterEach, expect, test } from "bun:test";
import type { BootedDevice, KeyboardResult } from "../../../src/models";
import { dismissKeyboardAfterSendKeys } from "../../../src/features/action/dismissKeyboardAfterSendKeys";
import { serverConfig } from "../../../src/utils/ServerConfig";

const android = { platform: "android" } as BootedDevice;
const ios = { platform: "ios" } as BootedDevice;
const closed: KeyboardResult = { success: true, open: false, message: "Keyboard closed" };
afterEach(() => serverConfig.setDismissKeyboardAfterInputEnabled(false));

test("configured Android successful sendKeys dismisses the keyboard", async () => {
  serverConfig.setDismissKeyboardAfterInputEnabled(true);
  let calls = 0;
  const result = await dismissKeyboardAfterSendKeys(
    android,
    serverConfig.isDismissKeyboardAfterInputEnabled(),
    true,
    async () => {
      calls++;
      return closed;
    },
  );
  expect(calls).toBe(1);
  expect(result).toEqual({ keyboardDismissed: true });
});

test("flag off and failed text entry do not close the keyboard", async () => {
  let calls = 0;
  const close = async () => {
    calls++;
    return closed;
  };
  expect(await dismissKeyboardAfterSendKeys(android, false, true, close)).toEqual({});
  expect(await dismissKeyboardAfterSendKeys(android, true, false, close)).toEqual({});
  expect(calls).toBe(0);
});

test("keyboard close failure is reported without escaping", async () => {
  const result = await dismissKeyboardAfterSendKeys(android, true, true, async () => {
    throw new Error("close failed");
  });
  expect(result).toEqual({
    keyboardDismissed: false,
    warnings: ["keyboard dismissal failed: close failed"],
  });
});

test("iOS does not close the keyboard", async () => {
  let calls = 0;
  expect(
    await dismissKeyboardAfterSendKeys(ios, true, true, async () => {
      calls++;
      return closed;
    }),
  ).toEqual({});
  expect(calls).toBe(0);
});
