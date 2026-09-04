import { describe, expect, test } from "bun:test";
import type { ReleaseChecksumEntry } from "../../src/constants/release";
import { isSendKeysReleased } from "../../src/features/action/SendKeys";
import type { BootedDevice } from "../../src/models";
import { assertSendKeysRunnerCompatible, sendKeysSchema } from "../../src/server/interactionTools";

function release(version: string): ReleaseChecksumEntry {
  return {
    version,
    apkSha256: "apk",
    ipaSha256: "ipa",
    runnerSha256: "runner",
  };
}

describe("sendKeysSchema", () => {
  test("accepts mixed commands and applies type defaults", () => {
    const parsed = sendKeysSchema.parse({
      platform: "android",
      selector: { elementId: "com.example:id/name" },
      commands: [
        { action: "type", text: "Ada" },
        { action: "key", key: "tab", modifiers: ["shift"] },
        { action: "key", key: "next", modifiers: ["meta"] },
        { action: "clear" },
      ],
    });

    expect(parsed.commands[0]).toEqual({
      action: "type",
      text: "Ada",
      operation: "insert",
      mode: "auto",
    });
  });

  test("rejects empty sequences and sequences over 100 commands", () => {
    expect(sendKeysSchema.safeParse({ platform: "ios", commands: [] }).success).toBe(false);
    expect(
      sendKeysSchema.safeParse({
        platform: "ios",
        commands: Array.from({ length: 101 }, () => ({ action: "clear" })),
      }).success,
    ).toBe(false);
  });

  test("rejects unknown keys, modifiers, and command fields", () => {
    expect(
      sendKeysSchema.safeParse({
        platform: "android",
        commands: [{ action: "key", key: "space" }],
      }).success,
    ).toBe(false);
    expect(
      sendKeysSchema.safeParse({
        platform: "android",
        commands: [{ action: "key", key: "enter", modifiers: ["super"] }],
      }).success,
    ).toBe(false);
    expect(
      sendKeysSchema.safeParse({
        platform: "android",
        commands: [{ action: "clear", text: "not allowed" }],
      }).success,
    ).toBe(false);
  });

  test("accepts every typing mode in cross-platform iOS plans", () => {
    for (const mode of ["auto", "a11y", "eventLast", "eventAll", "eventOnly"]) {
      expect(
        sendKeysSchema.safeParse({
          platform: "ios",
          commands: [{ action: "type", text: "value", mode }],
        }).success,
      ).toBe(true);
    }
  });

  test("hands the default tool profile over only after the coordinated release", () => {
    expect(isSendKeysReleased({}, [release("0.0.67")])).toBe(false);
    expect(isSendKeysReleased({}, [release("0.0.68"), release("0.0.67")])).toBe(true);
    expect(
      isSendKeysReleased({ AUTOMOBILE_VERSION: "0.0.67" }, [release("0.0.68"), release("0.0.67")]),
    ).toBe(false);
    expect(
      isSendKeysReleased({ AUTOMOBILE_VERSION: "0.0.69" }, [release("0.0.68"), release("0.0.67")]),
    ).toBe(false);
  });

  test("preflights platform runner capabilities before execution", async () => {
    const android = {
      deviceId: "android",
      name: "Android",
      platform: "android",
    } satisfies BootedDevice;
    const ios = {
      deviceId: "ios",
      name: "iOS",
      platform: "ios",
    } satisfies BootedDevice;

    await expect(
      assertSendKeysRunnerCompatible(android, () => ({
        getSupportedCommands: async () => ["request_insert_text"],
      })),
    ).resolves.toBeUndefined();
    await expect(
      assertSendKeysRunnerCompatible(ios, () => ({
        getSupportedCommands: async () => ["request_press_key"],
      })),
    ).resolves.toBeUndefined();
    await expect(
      assertSendKeysRunnerCompatible(android, () => ({
        getSupportedCommands: async () => [],
      })),
    ).rejects.toThrow("request_insert_text is unavailable");
    await expect(
      assertSendKeysRunnerCompatible(ios, () => ({
        getSupportedCommands: async () => null,
      })),
    ).rejects.toThrow("request_press_key is unavailable");
  });
});
