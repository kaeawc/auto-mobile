import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerSharedStorageTools } from "../../src/server/sharedStorageTools";

describe("shared-storage tools", () => {
  beforeEach(() => (ToolRegistry as any).tools.clear());
  afterEach(() => (ToolRegistry as any).tools.clear());

  test("registers a discoverable session-bound staging operation", () => {
    registerSharedStorageTools();
    const tools = ToolRegistry.getToolDefinitions().filter(
      (candidate) =>
        candidate.name === "stageSharedStorage" || candidate.name === "stageSharedStorageFixtures",
    );
    expect(tools).toHaveLength(2);
    const tool = tools.find((candidate) => candidate.name === "stageSharedStorage");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties.namespace).toBeDefined();
    expect(tool!.inputSchema.properties.reset).toBeDefined();
    expect(tool!.inputSchema.properties.files).toBeDefined();
    expect(ToolRegistry.getTool("stageSharedStorage")!.defaultEnabled).toBe(true);
    expect(ToolRegistry.getTool("stageSharedStorageFixtures")!.defaultEnabled).toBe(false);
  });

  test("advertises defaulted fields as optional", () => {
    registerSharedStorageTools();
    for (const name of ["stageSharedStorage", "stageSharedStorageFixtures"]) {
      const tool = ToolRegistry.getToolDefinitions().find((candidate) => candidate.name === name)!;
      const validate = new Ajv2020({ strict: false }).compile(tool.inputSchema);

      expect(
        validate({
          namespace: "run-42",
          files: [{ contentText: "fixture", destinationPath: "fixture.txt" }],
        }),
      ).toBe(true);
    }
  });
});
