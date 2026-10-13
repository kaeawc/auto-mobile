import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerMcpTools } from "../../../src/server";
import { ToolRegistry } from "../../../src/server/toolRegistry";

type AdvertisedTool = ReturnType<typeof ToolRegistry.getToolDefinitions>[number];

function getTool(definitions: AdvertisedTool[], name: string): AdvertisedTool {
  const tool = definitions.find((candidate) => candidate.name === name);
  expect(tool, `${name} should be advertised`).toBeDefined();
  return tool!;
}

function propertiesFor(tool: AdvertisedTool): Record<string, unknown> {
  const properties = tool.inputSchema.properties;
  expect(properties, `${tool.name} should advertise object properties`).toBeDefined();
  return properties as Record<string, unknown>;
}

describe("advertised deviceId schema", () => {
  let definitions: AdvertisedTool[];
  // Tests only read definitions, getTool, and schema.parse; nothing here mutates the registry, and Bun does not interleave another file's hooks/tests.
  beforeAll(() => {
    ToolRegistry.clearTools();
    registerMcpTools(false);
    definitions = ToolRegistry.getToolDefinitions();
  });

  afterAll(() => {
    ToolRegistry.clearTools();
  });

  test("exposes observe deviceId and hides it on other executor-routed tools", () => {
    expect(propertiesFor(getTool(definitions, "observe")).deviceId).toBeDefined();
    for (const toolName of ["tapOn", "swipeOn", "changeLocalization"]) {
      expect(
        propertiesFor(getTool(definitions, toolName)).deviceId,
        `${toolName} should hide injected deviceId`,
      ).toBeUndefined();
    }

    for (const toolName of ["setActiveDevice", "videoRecording", "highlight"]) {
      expect(
        propertiesFor(getTool(definitions, toolName)).deviceId,
        `${toolName} should keep agent-facing deviceId`,
      ).toBeDefined();
    }

    const killDeviceProperties = propertiesFor(getTool(definitions, "killDevice"));
    const deviceProperty = killDeviceProperties.device as { properties?: Record<string, unknown> };
    expect(
      deviceProperty.properties?.deviceId,
      "killDevice should keep agent-facing nested device.deviceId",
    ).toBeDefined();
  });

  test("keeps executor-injected deviceId accepted by runtime validation", () => {
    const observeTool = ToolRegistry.getTool("observe");
    expect(observeTool, "observe should be registered").toBeDefined();

    expect(() =>
      observeTool!.schema.parse({ platform: "android", deviceId: "emulator-5554" }),
    ).not.toThrow();
  });
});
