import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerNotificationTools } from "../../src/server/notificationTools";
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
});
