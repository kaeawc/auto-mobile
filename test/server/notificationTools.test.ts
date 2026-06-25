import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { postNotificationSchema, registerNotificationTools } from "../../src/server/notificationTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("notification tools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerNotificationTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("registers notification policy schemas", () => {
    const getTool = ToolRegistry.getTool("getNotificationPolicy");
    const setTool = ToolRegistry.getTool("setNotificationPolicy");

    expect(getTool).toBeDefined();
    expect(getTool?.requiresDevice).toBe(true);
    expect(() => getTool!.schema.parse({
      appId: "com.example.app",
    })).not.toThrow();
    expect(() => getTool!.schema.parse({})).toThrow();

    expect(setTool).toBeDefined();
    expect(setTool?.requiresDevice).toBe(true);
    expect(() => setTool!.schema.parse({
      appId: "com.example.app",
      policyAccess: true,
    })).not.toThrow();
    expect(() => setTool!.schema.parse({
      appId: "com.example.app",
    })).toThrow();
  });

  test("requires appId when posting notifications on iOS", () => {
    const result = postNotificationSchema.safeParse({
      platform: "ios",
      title: "T",
      body: "B",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["appId"]);
      expect(result.error.issues[0].message).toBe("appId is required when platform is ios");
    }
  });

  test("keeps appId optional when posting notifications on Android", () => {
    const result = postNotificationSchema.safeParse({
      platform: "android",
      title: "T",
      body: "B",
    });

    expect(result.success).toBe(true);
  });

  test("keeps generated tool definition free of top-level combinators", () => {
    const toolDefinition = ToolRegistry.getToolDefinitions()
      .find(tool => tool.name === "postNotification");

    expect(toolDefinition).toBeDefined();
    const schema = toolDefinition!.inputSchema as any;
    expect(schema.required).toEqual(["title", "body", "platform"]);
    expect(schema.properties.platform.enum).toEqual(["ios", "android"]);
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema.allOf).toBeUndefined();
  });
});
