import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  registerAccessibilityTools,
  accessibilitySchema,
} from "../../src/server/accessibilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { VoiceOverToggle } from "../../src/features/accessibility/VoiceOverToggle";
import type { BootedDevice } from "../../src/models";
import type { VoiceOverResult } from "../../src/models/AccessibilityResult";

const ANDROID_DEVICE = {
  name: "a",
  deviceId: "emulator-5554",
  platform: "android",
} as BootedDevice;
const IOS_DEVICE = { name: "i", deviceId: "00008130-001", platform: "ios" } as BootedDevice;

function accessibilityHandler() {
  const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find(
    (t) => t.name === "accessibility",
  );
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
      const names = ToolRegistry.getToolDefinitions().map((t) => t.name);
      expect(names).toContain("accessibility");
    });
  });

  describe("platform rejection", () => {
    // Both rows short-circuit before any toggle/client is constructed, so no real
    // device is touched. Only the two THROW rows are covered (issue #4179).
    test("rejects voiceover on an Android device", async () => {
      registerAccessibilityTools();
      await expect(accessibilityHandler()(ANDROID_DEVICE, { voiceover: true })).rejects.toThrow(
        "VoiceOver is not supported on Android devices",
      );
    });

    test("rejects talkback on an iOS device", async () => {
      registerAccessibilityTools();
      await expect(accessibilityHandler()(IOS_DEVICE, { talkback: true })).rejects.toThrow(
        "TalkBack is not supported on iOS devices",
      );
    });
  });

  describe("VoiceOver unconfirmed toggle (#6496)", () => {
    afterEach(() => {
      // spyOn is restorable per-mock (unlike mock.module, which leaks across
      // test files), so the real VoiceOverToggle.toggle is back in place for
      // every other suite that constructs a real instance.
      toggleSpy?.mockRestore();
      toggleSpy = undefined;
    });

    let toggleSpy: ReturnType<typeof spyOn> | undefined;

    // An unconfirmed toggle (applied:false with a reason, e.g. a CtrlProxy
    // outage during confirmation polling) must surface as an actionable
    // failure at the MCP boundary rather than a normal enabled:false
    // response — otherwise the client can't distinguish "confirmed off"
    // from "we don't actually know" (codex review on PR #6768).
    test("throws with the reason when the toggle result is unconfirmed", async () => {
      const unconfirmedResult: VoiceOverResult = {
        supported: true,
        applied: false,
        reason: "VoiceOver state could not be confirmed within 10000ms",
      };
      toggleSpy = spyOn(VoiceOverToggle.prototype, "toggle").mockResolvedValue(unconfirmedResult);

      registerAccessibilityTools();
      await expect(accessibilityHandler()(IOS_DEVICE, { voiceover: false })).rejects.toThrow(
        "VoiceOver state could not be confirmed within 10000ms",
      );
    });
  });

  describe("schema validation", () => {
    // Collapsed from 8 hand-rolled siblings into a single table so a failing
    // row is named, plus the boundary rows the siblings never specified: null,
    // explicit undefined, and an unknown key (issue #4183 item 18).
    const cases: ReadonlyArray<{ name: string; input: unknown; valid: boolean }> = [
      { name: "talkback: true", input: { talkback: true }, valid: true },
      { name: "talkback: false", input: { talkback: false }, valid: true },
      { name: "empty object (all params optional)", input: {}, valid: true },
      { name: "talkback as a string", input: { talkback: "yes" }, valid: false },
      { name: "talkback as a number", input: { talkback: 1 }, valid: false },
      { name: "talkback as null", input: { talkback: null }, valid: false },
      { name: "talkback explicitly undefined", input: { talkback: undefined }, valid: true },
      { name: "voiceover: true", input: { voiceover: true }, valid: true },
      { name: "voiceover: false", input: { voiceover: false }, valid: true },
      { name: "voiceover as a string", input: { voiceover: "yes" }, valid: false },
      { name: "voiceover as a number", input: { voiceover: 1 }, valid: false },
      { name: "voiceover as null", input: { voiceover: null }, valid: false },
      // z.object strips unknown keys rather than rejecting them, so an
      // unknown key is accepted (verified: accepted, issue #4183 item 18).
      { name: "an unknown key", input: { unknownKey: true }, valid: true },
    ];

    test.each(cases)("$valid for $name", ({ input, valid }) => {
      if (valid) {
        expect(() => accessibilitySchema.parse(input)).not.toThrow();
      } else {
        expect(() => accessibilitySchema.parse(input)).toThrow();
      }
    });
  });
});
