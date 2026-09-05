import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clipboardSchema,
  formatClipboardMessage,
  formatRecentAppsMessage,
  registerInteractionTools,
} from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("clipboard tool schema", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerInteractionTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("requires text when action is copy", () => {
    const result = clipboardSchema.safeParse({
      action: "copy",
      platform: "ios",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["text"]);
      expect(result.error.issues[0].message).toBe("text is required when action is copy");
    }
  });

  test("keeps text optional for non-copy actions", () => {
    for (const action of ["paste", "clear", "get"] as const) {
      const result = clipboardSchema.safeParse({
        action,
        platform: "android",
      });

      expect(result.success).toBe(true);
    }
  });

  test("rejects empty text when text is provided for any action", () => {
    for (const action of ["copy", "paste", "clear", "get"] as const) {
      const result = clipboardSchema.safeParse({
        action,
        text: "",
        platform: "android",
      });

      expect(result.success).toBe(false);
    }
  });

  test("keeps generated tool definition free of top-level combinators", () => {
    const toolDefinition = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "clipboard",
    );

    expect(toolDefinition).toBeDefined();
    const schema = toolDefinition!.inputSchema as any;
    // #6154: platform is optional wherever deviceId/session resolves it.
    expect(schema.required).toEqual(["action"]);
    expect(schema.properties.action.enum).toEqual(["copy", "paste", "clear", "get"]);
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema.allOf).toBeUndefined();
  });

  test("formats failed actions without success wording", () => {
    for (const action of ["copy", "paste", "clear", "get"] as const) {
      const message = formatClipboardMessage({
        success: false,
        action,
        error: "Clipboard access denied",
      });

      expect(message).toBe(`Failed to execute clipboard ${action}: Clipboard access denied`);
      expect(message).not.toContain("Copied");
      expect(message).not.toContain("Pasted");
      expect(message).not.toContain("Cleared");
      expect(message).not.toContain("Retrieved empty");
    }
  });

  test("formats successful get with content preview and empty clipboard message", () => {
    expect(
      formatClipboardMessage({
        success: true,
        action: "get",
        text: "hello",
      }),
    ).toBe('Retrieved clipboard content: "hello"');

    expect(
      formatClipboardMessage({
        success: true,
        action: "get",
        text: "",
      }),
    ).toBe("Retrieved empty clipboard");
  });

  test("formats failed recentApps without success wording", () => {
    const message = formatRecentAppsMessage({
      success: false,
      error: "iOS App Switcher did not appear after recent apps invocation",
    });

    expect(message).toBe(
      "Failed to open recent apps: iOS App Switcher did not appear after recent apps invocation",
    );
    expect(message).not.toContain("Opened recent apps");
  });
});
