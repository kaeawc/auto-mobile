import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clipboardSchema, registerInteractionTools } from "../../src/server/interactionTools";
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
    const toolDefinition = ToolRegistry.getToolDefinitions()
      .find(tool => tool.name === "clipboard");

    expect(toolDefinition).toBeDefined();
    const schema = toolDefinition!.inputSchema as any;
    expect(schema.required).toEqual(["action", "platform"]);
    expect(schema.properties.action.enum).toEqual(["copy", "paste", "clear", "get"]);
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema.allOf).toBeUndefined();
  });
});
