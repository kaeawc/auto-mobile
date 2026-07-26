import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerAccessibilityTools, accessibilitySchema } from "../../src/server/accessibilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";

const ANDROID_DEVICE = { name: "a", deviceId: "emulator-5554", platform: "android" } as BootedDevice;
const IOS_DEVICE = { name: "i", deviceId: "00008130-001", platform: "ios" } as BootedDevice;

function accessibilityHandler() {
  const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find(t => t.name === "accessibility");
  if (!tool?.deviceAwareHandler) {
    throw new Error("accessibility tool not registered");
  }
  return tool.deviceAwareHandler;
}

describe("accessibilityTools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  describe("registration", () => {
    test("registers the accessibility tool", () => {
      registerAccessibilityTools();
      const names = ToolRegistry.getToolDefinitions().map(t => t.name);
      expect(names).toContain("accessibility");
    });
  });

  describe("platform rejection", () => {
    // Both rows short-circuit before any toggle/client is constructed, so no real
    // device is touched. Only the two THROW rows are covered (issue #4179).
    test("rejects voiceover on an Android device", async () => {
      registerAccessibilityTools();
      await expect(
        accessibilityHandler()(ANDROID_DEVICE, { voiceover: true })
      ).rejects.toThrow("VoiceOver is not supported on Android devices");
    });

    test("rejects talkback on an iOS device", async () => {
      registerAccessibilityTools();
      await expect(
        accessibilityHandler()(IOS_DEVICE, { talkback: true })
      ).rejects.toThrow("TalkBack is not supported on iOS devices");
    });
  });

  describe("schema validation", () => {
    test("accepts talkback: true", () => {
      expect(() => accessibilitySchema.parse({ talkback: true })).not.toThrow();
    });

    test("accepts talkback: false", () => {
      expect(() => accessibilitySchema.parse({ talkback: false })).not.toThrow();
    });

    test("accepts empty object (all params optional)", () => {
      expect(() => accessibilitySchema.parse({})).not.toThrow();
    });

    test("rejects talkback as a string", () => {
      expect(() => accessibilitySchema.parse({ talkback: "yes" })).toThrow();
    });

    test("rejects talkback as a number", () => {
      expect(() => accessibilitySchema.parse({ talkback: 1 })).toThrow();
    });

    test("accepts voiceover: true", () => {
      expect(() => accessibilitySchema.parse({ voiceover: true })).not.toThrow();
    });

    test("accepts voiceover: false", () => {
      expect(() => accessibilitySchema.parse({ voiceover: false })).not.toThrow();
    });

    test("rejects voiceover as a string", () => {
      expect(() => accessibilitySchema.parse({ voiceover: "yes" })).toThrow();
    });

    test("rejects voiceover as a number", () => {
      expect(() => accessibilitySchema.parse({ voiceover: 1 })).toThrow();
    });
  });
});
