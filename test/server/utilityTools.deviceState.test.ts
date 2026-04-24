import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("device state tools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerUtilityTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("registers getDeviceState and setDeviceState schemas", () => {
    const getTool = ToolRegistry.getTool("getDeviceState");
    const setTool = ToolRegistry.getTool("setDeviceState");

    expect(getTool).toBeDefined();
    expect(getTool?.requiresDevice).toBe(true);
    expect(() => getTool!.schema.parse({ include: ["doNotDisturb"] })).not.toThrow();

    expect(setTool).toBeDefined();
    expect(setTool?.requiresDevice).toBe(true);
    expect(() => setTool!.schema.parse({
      doNotDisturb: { enabled: true },
    })).not.toThrow();
    expect(() => setTool!.schema.parse({
      doNotDisturb: { mode: "priority" },
    })).not.toThrow();
    expect(() => setTool!.schema.parse({})).toThrow();
  });
});
