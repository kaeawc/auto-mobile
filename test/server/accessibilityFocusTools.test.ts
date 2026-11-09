import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { registerAccessibilityFocusTools } from "../../src/server/accessibilityFocusTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { SetAccessibilityFocus } from "../../src/features/accessibility/SetAccessibilityFocus";
import { ActionableError, type BootedDevice } from "../../src/models";

isolateToolRegistry();

/**
 * accessibilityFocus is a debug-only device-aware tool. `getTool`/the default
 * listing gate on availability (which is false for a debugOnly tool when --debug
 * is off), so it must be resolved via getAllTools({ includeUnavailable: true }).
 */
describe("accessibilityFocusTools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  function focusTool() {
    return ToolRegistry.getAllTools({ includeUnavailable: true }).find(
      (t) => t.name === "accessibilityFocus",
    );
  }

  test("registers the accessibilityFocus device-aware tool", () => {
    registerAccessibilityFocusTools();

    const tool = focusTool();
    expect(tool).toBeDefined();
    expect(tool!.requiresDevice).toBe(true);
    expect(tool!.deviceAwareHandler).toBeDefined();
  });

  test("marks the tool debugOnly", () => {
    registerAccessibilityFocusTools();

    expect(focusTool()!.debugOnly).toBe(true);
  });

  test("hides the tool from the default (non-debug) listing", () => {
    registerAccessibilityFocusTools();

    // With --debug off a debugOnly tool is unavailable, so it is absent from the
    // default listing and from getToolDefinitions but present when unavailable
    // tools are included. Removing the debugOnly flag would leak it to every
    // client.
    const defaultNames = ToolRegistry.getAllTools().map((t) => t.name);
    const allNames = ToolRegistry.getAllTools({ includeUnavailable: true }).map((t) => t.name);
    const advertisedNames = ToolRegistry.getToolDefinitions().map((t) => t.name);

    expect(allNames).toContain("accessibilityFocus");
    expect(defaultNames).not.toContain("accessibilityFocus");
    expect(advertisedNames).not.toContain("accessibilityFocus");
  });
  test("describes Android and iOS support", () => {
    registerAccessibilityFocusTools();
    expect(focusTool()!.description).toContain("Android (TalkBack)");
    expect(focusTool()!.description).toContain("iOS (VoiceOver)");
  });

  test("passes the injected iOS client factory through to the feature", async () => {
    const device = { deviceId: "fake-ios", platform: "ios" as const, name: "Fake" };
    const devices: BootedDevice[] = [];
    registerAccessibilityFocusTools({
      iosServiceFactory: (resolvedDevice) => {
        devices.push(resolvedDevice);
        return {
          requestAccessibilityFocus: async () => ({ success: true, totalTimeMs: 0 }),
        };
      },
    });
    const response = await focusTool()!.deviceAwareHandler!(device, { text: "Save" });
    expect(devices).toEqual([device]);
    expect(response).toHaveProperty("structuredContent.success", true);
  });

  test("iOS success returns unconfirmed focus with a warning", async () => {
    registerAccessibilityFocusTools();
    const result = { success: true, confirmed: false, warning: "VoiceOver focus was posted" };
    const execute = spyOn(SetAccessibilityFocus.prototype, "execute").mockResolvedValue(result);
    try {
      const response = await focusTool()!.deviceAwareHandler!(
        { deviceId: "fake-ios", platform: "ios", name: "Fake" },
        { resourceId: "save" },
      );
      expect(response).toHaveProperty("structuredContent", result);
    } finally {
      execute.mockRestore();
    }
  });

  test.each([
    { success: false, errorCode: "voiceover_off" as const, error: "Enable VoiceOver" },
    { success: false, errorCode: "unsupported" as const, error: "No reliable clear" },
    { success: false, errorCode: "sdk_unavailable" as const, error: "SDK missing" },
    { success: false, errorCode: "element_not_found" as const, error: "No element matched" },
    { success: false, errorCode: "invalid_selector" as const, error: "Selector required" },
  ])("iOS $errorCode failure throws an actionable error", async (result) => {
    registerAccessibilityFocusTools();
    const execute = spyOn(SetAccessibilityFocus.prototype, "execute").mockResolvedValue(result);
    try {
      const response = focusTool()!.deviceAwareHandler!(
        { deviceId: "fake-ios", platform: "ios", name: "Fake" },
        { resourceId: "save" },
      );
      await expect(response).rejects.toBeInstanceOf(ActionableError);
      await expect(response).rejects.toHaveProperty("message", result.error);
    } finally {
      execute.mockRestore();
    }
  });

  test.each([
    ["ios", "Failed to set VoiceOver focus"],
    ["android", "Failed to update accessibility focus"],
  ] as const)(
    "%s failure uses the platform fallback when error is absent",
    async (platform, message) => {
      registerAccessibilityFocusTools();
      const execute = spyOn(SetAccessibilityFocus.prototype, "execute").mockResolvedValue({
        success: false,
      });
      try {
        const response = focusTool()!.deviceAwareHandler!(
          { deviceId: `fake-${platform}`, platform, name: "Fake" },
          { resourceId: "save" },
        );
        await expect(response).rejects.toBeInstanceOf(ActionableError);
        await expect(response).rejects.toHaveProperty("message", message);
      } finally {
        execute.mockRestore();
      }
    },
  );
});
