import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolDefinitionListing } from "../../src/server/ToolDefinitionListing";
import type { RegisteredTool } from "../../src/server/toolRegistryTypes";
import { deriveToolRequirements } from "../../src/server/toolRequirements";

const TABLE = {
  watchos: new Set(["crown", "tap"]),
  tvos: new Set(["tap"]),
  visionos: new Set<string>(),
};

const NO_PLATFORM_FIELD = { type: "object", properties: {} };

describe("deriveToolRequirements (#18141)", () => {
  test("a plain tool with no gate has no requirements", () => {
    expect(deriveToolRequirements({ name: "listDevices" }, NO_PLATFORM_FIELD, TABLE)).toEqual([]);
  });

  test("a device tool reaches Android and iOS, plus each Apple platform it opted in to", () => {
    expect(
      deriveToolRequirements({ name: "tap", requiresDevice: true }, NO_PLATFORM_FIELD, TABLE),
    ).toEqual(["platform:android", "platform:ios", "platform:watchos", "platform:tvos"]);
  });

  test("the input schema's platform vocabulary narrows the gate", () => {
    const schema = { properties: { platform: { const: "watchos" } } };
    expect(deriveToolRequirements({ name: "crown", requiresDevice: true }, schema, TABLE)).toEqual([
      "platform:watchos",
    ]);
    const enumSchema = { properties: { platform: { enum: ["android", "tvos"] } } };
    expect(
      deriveToolRequirements({ name: "tap", requiresDevice: true }, enumSchema, TABLE),
    ).toEqual(["platform:android", "platform:tvos"]);
  });

  test("gates come first in a stable order, flags sorted and deduplicated", () => {
    expect(
      deriveToolRequirements(
        {
          name: "x",
          requiresDevice: true,
          embeddedSdkOnly: true,
          debugOnly: true,
          featureFlags: ["tool-call-recording", "device-condition", "device-condition"],
        },
        NO_PLATFORM_FIELD,
        TABLE,
      ),
    ).toEqual([
      "sdkEmbed",
      "debugBuild",
      "featureFlag:device-condition",
      "featureFlag:tool-call-recording",
      "platform:android",
      "platform:ios",
    ]);
  });
});

describe("ToolDefinitionListing requirements (#18141)", () => {
  const tools: RegisteredTool[] = [
    {
      name: "sqlQuery",
      description: "sql",
      schema: z.object({}),
      handler: async () => ({}),
      defaultEnabled: true,
      defaultDeclared: true,
      requiresDevice: true,
      embeddedSdkOnly: true,
    },
    {
      name: "listDevices",
      description: "list",
      schema: z.object({}),
      handler: async () => ({}),
      defaultEnabled: true,
      defaultDeclared: true,
    },
  ];
  const listing = new ToolDefinitionListing(
    () => tools,
    () => false,
    () => ({ inputSchema: NO_PLATFORM_FIELD, outputSchema: undefined }),
  );

  test("the catalog listing carries requires on every tool, empty when none", () => {
    const requires = listing
      .getToolDefinitions({ includeRequirements: true })
      .map((definition) => [definition.name, definition._meta?.["automobile/requires"]]);
    expect(requires).toEqual([
      ["listDevices", []],
      ["sqlQuery", ["sdkEmbed", "platform:android", "platform:ios"]],
    ]);
  });

  test("live tools/list leaves it out", () => {
    const listed = listing.getToolDefinitions();
    expect(listed.map((definition) => definition._meta?.["automobile/requires"])).toEqual([
      undefined,
      undefined,
    ]);
  });
});
