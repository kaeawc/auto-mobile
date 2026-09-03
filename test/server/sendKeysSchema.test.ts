import { describe, expect, test } from "bun:test";
import { sendKeysSchema } from "../../src/server/interactionTools";

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
});
