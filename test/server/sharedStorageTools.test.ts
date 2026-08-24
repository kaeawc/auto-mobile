import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerSharedStorageTools } from "../../src/server/sharedStorageTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("Shared storage tools", () => {
  beforeEach(() => {
    (ToolRegistry as any).tools.clear();
  });

  afterEach(() => {
    (ToolRegistry as any).tools.clear();
  });

  test("registers an Android shared-storage fixture operation", () => {
    registerSharedStorageTools();
    const tool = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "stageSharedStorageFixtures",
    );
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties.namespace).toBeDefined();
    expect(tool!.inputSchema.properties.files).toBeDefined();
    expect(tool!.inputSchema.properties.reset).toBeDefined();
  });
});
