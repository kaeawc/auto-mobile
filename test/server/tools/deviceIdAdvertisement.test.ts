import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("hides executor-injected deviceId while keeping agent-facing deviceId", () => {
    registerMcpTools(false);

    const definitions = ToolRegistry.getToolDefinitions();

    for (const toolName of ["observe", "tapOn", "swipeOn", "changeLocalization"]) {
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
    registerMcpTools(false);

    const observeTool = ToolRegistry.getTool("observe");
    expect(observeTool, "observe should be registered").toBeDefined();

    expect(() =>
      observeTool!.schema.parse({ platform: "android", deviceId: "emulator-5554" }),
    ).not.toThrow();
  });
});
