import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import {
  getNavigationGraphResultSchema,
  navigateToResultSchema,
} from "../../src/server/navigationToolOutputSchemas";
import { registerNavigationTools } from "../../src/server/navigationTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import { advertisedOutputSchema, jsonSchemaObjects } from "../helpers/advertisedOutputSchemas";
import { compileAjv2020 } from "../helpers/jsonSchemaCompile";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const navigated = {
  message: 'Successfully navigated to "Settings"',
  success: true,
  currentScreen: "Settings",
  targetScreen: "Settings",
  stepsExecuted: 1,
  path: ["tapOn"],
  durationMs: 5,
};

const graph = {
  message: "Navigation graph for app: com.example",
  requestedAppId: null,
  observedAppId: "com.example",
  currentScreen: "Home",
  nodeCount: 2,
  edgeCount: 2,
  knownEdges: 1,
  unknownEdges: 0,
  screens: [{ name: "Home", visitCount: 2, lastVisited: "1970-01-01T00:00:01.000Z" }],
  transitions: [
    {
      from: "Home",
      to: "Settings",
      type: "tool",
      tool: "tapOn",
      args: { text: "Settings" },
      uiState: {
        selectedElements: [
          { text: "Home", selectedState: { method: "accessibility", confidence: 1 } },
        ],
        modalStack: [{ type: "bottomsheet", layer: 1 }],
        scrollPosition: { targetElement: { text: "Settings" }, direction: "down" },
      },
    },
    { from: "Settings", to: "Home", type: "back" },
  ],
};

describe("navigation tool output schemas", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerNavigationTools();
  });
  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test.each([
    ["navigateTo", navigateToResultSchema],
    ["getNavigationGraph", getNavigationGraphResultSchema],
  ])("%s declares its outputSchema", (name, schema) => {
    expect(ToolRegistry.getRegisteredTool(name)?.outputSchema).toBe(schema);
  });

  // Its completed/dry-run union has no object root: a spilled response keeps only
  // `success`/`error`, which an advertised outputSchema would reject.
  test("explore stays schemaless", () => {
    expect(ToolRegistry.getRegisteredTool("explore")?.outputSchema).toBeUndefined();
  });

  // A schema instance shared across fields is advertised as a `$ref` Ajv cannot resolve.
  test.each([
    ["navigateTo", navigateToResultSchema],
    ["getNavigationGraph", getNavigationGraphResultSchema],
  ])("%s advertises its outputSchema without a $ref", (_name, schema) => {
    const refs = jsonSchemaObjects(advertisedOutputSchema(schema, "ref")).filter(
      (node) => "$ref" in node,
    );
    expect(refs).toEqual([]);
  });

  test.each([
    ["success", navigated, true],
    [
      "failure",
      {
        error: "Navigation timeout (30 seconds)",
        success: false,
        currentScreen: null,
        targetScreen: "Settings",
        stepsExecuted: 0,
        partialPath: [],
      },
      true,
    ],
    ["targetless", { ...navigated, targetScreen: undefined }, false],
  ])("navigateTo schema on a %s payload", (_label, payload, accepted) => {
    expect(navigateToResultSchema.safeParse(payload).success).toBe(accepted);
  });

  test("getNavigationGraph accepts tool and back transitions and rejects an unknown edge type", () => {
    expect(getNavigationGraphResultSchema.safeParse(graph).success).toBe(true);
    expect(
      getNavigationGraphResultSchema.safeParse({
        ...graph,
        transitions: [{ from: "Home", to: "Settings", type: "teleport" }],
      }).success,
    ).toBe(false);
  });

  test.each([
    ["navigateTo", { ...navigated, path: Array.from({ length: 10_000 }, () => "tapOn") }],
    [
      "getNavigationGraph",
      {
        ...graph,
        screens: Array.from({ length: 1_500 }, (_, i) => ({
          name: `Screen${i}`,
          visitCount: 1,
          lastVisited: "1970-01-01T00:00:01.000Z",
        })),
      },
    ],
  ] as const)(
    "%s keeps a spilled response valid against its advertised schema",
    (name, payload) => {
      const outputSchema = ToolRegistry.getRegisteredTool(name)!.outputSchema!;
      const spilled = finalizeToolResponse(createStructuredToolResponse(payload), {
        name,
        outputSchema,
        artifactWriter: new FakeArtifactWriter(),
      }).structuredContent as Record<string, unknown>;
      expect(spilled.artifact).toBeDefined();
      const validate = compileAjv2020(advertisedOutputSchema(outputSchema, "inline"));
      expect(validate(spilled)).toBe(true);
    },
  );
});
