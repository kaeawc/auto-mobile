import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import {
  exploreResultSchema,
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

const explored = {
  message: "Exploration completed: 1 interactions, 1 new screens discovered, 50% coverage",
  success: true,
  cancelled: false,
  interactionsPerformed: 1,
  screensDiscovered: 1,
  edgesAdded: 1,
  navigationGraph: {
    appId: "com.example",
    nodes: [
      {
        screenName: "Home",
        firstSeenAt: 0,
        lastSeenAt: 1_000,
        visitCount: 2,
        modalStack: [{ type: "dialog", layer: 1 }],
      },
    ],
    edges: [
      {
        from: "Home",
        to: "Settings",
        timestamp: 500,
        edgeType: "tool",
        interaction: {
          toolName: "tapOn",
          args: { text: "Settings" },
          timestamp: 400,
          uiState: { selectedElements: [{ text: "Home" }] },
        },
        uiState: { selectedElements: [{ text: "Home" }] },
      },
    ],
    currentScreen: "Settings",
  },
  explorationPath: ["Home", "Settings"],
  coverage: { totalScreens: 4, exploredScreens: 2, percentage: 50 },
  elementSelections: [{ text: "Settings", score: 1, novelty: 1, coverage: 0, finalScore: 1 }],
  durationMs: 10,
  stopReason: "Reached max interactions",
  graphTraversal: {
    nodesVisited: 2,
    totalNodes: 2,
    edgesTraversed: 1,
    totalEdges: 1,
    edgeValidationResults: [
      {
        edgeKey: "Home->Settings",
        fromScreen: "Home",
        expectedTo: "Settings",
        actualTo: null,
        success: false,
        timestamp: 1,
        error: "no transition",
      },
    ],
    coveragePercentage: 100,
  },
};

const plannedInteraction = {
  order: 1,
  action: "tapOn",
  target: { type: "text", value: "Settings" },
  reason: "unexplored",
  predictedOutcome: { screen: "Settings", confidence: 0.9 },
  whitelistStatus: "allowed",
};

const dryRun = {
  message: "Exploration dry run completed: 1 planned interactions",
  success: true,
  dryRun: true,
  currentScreen: { name: "Home", interactableElements: 1 },
  plannedInteractions: [plannedInteraction],
  estimatedCoverage: {
    screensToVisit: ["Settings"],
    newScreensExpected: 0,
    existingScreensToRevisit: 1,
  },
  warnings: [],
  durationMs: 3,
};

// The observation-bearing explore schema costs a noticeable compile; do it once.
let validateExplore: ReturnType<typeof compileAjv2020>;
beforeAll(() => {
  validateExplore = compileAjv2020(advertisedOutputSchema(exploreResultSchema, "ref"));
});

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
    ["explore", exploreResultSchema],
  ])("%s declares its outputSchema", (name, schema) => {
    expect(ToolRegistry.getRegisteredTool(name)?.outputSchema).toBe(schema);
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
    ["completed", explored],
    ["failed", { ...explored, success: false, error: "explore failed" }],
    ["dry run", dryRun],
  ])("explore advertised schema accepts a %s payload", (_label, payload) => {
    expect([validateExplore(payload), exploreResultSchema.safeParse(payload).success]).toEqual([
      true,
      true,
    ]);
  });

  // A spilled response keeps only required fields, so only what both outcomes carry is.
  test.each([
    ["completed", explored],
    ["dry run", dryRun],
  ])("explore requires message, success and durationMs on a %s payload", (_label, payload) => {
    expect(
      ["message", "success", "durationMs"].filter(
        (key) =>
          exploreResultSchema.safeParse(
            Object.fromEntries(Object.entries(payload).filter(([field]) => field !== key)),
          ).success,
      ),
    ).toEqual([]);
  });

  test.each([
    ["a non-literal dryRun", { ...dryRun, dryRun: false }],
    [
      "an unknown planned action",
      { ...dryRun, plannedInteractions: [{ ...plannedInteraction, action: "longPress" }] },
    ],
    [
      "an unknown target type",
      {
        ...dryRun,
        plannedInteractions: [{ ...plannedInteraction, target: { type: "xpath", value: "//a" } }],
      },
    ],
    [
      "an unknown whitelist status",
      { ...dryRun, plannedInteractions: [{ ...plannedInteraction, whitelistStatus: "maybe" }] },
    ],
    [
      "an unknown edge type",
      {
        ...explored,
        navigationGraph: {
          ...explored.navigationGraph,
          edges: [{ ...explored.navigationGraph.edges[0], edgeType: "teleport" }],
        },
      },
    ],
    [
      "an unknown modal type",
      {
        ...explored,
        navigationGraph: {
          ...explored.navigationGraph,
          nodes: [
            { ...explored.navigationGraph.nodes[0], modalStack: [{ type: "toast", layer: 1 }] },
          ],
        },
      },
    ],
  ])("explore rejects %s", (_label, payload) => {
    expect(exploreResultSchema.safeParse(payload).success).toBe(false);
  });

  // The client does not validate isError results, so every documented value is pinned here.
  test("explore accepts every documented enum value", () => {
    const planned = (overrides: Record<string, unknown>) => ({
      ...dryRun,
      plannedInteractions: [{ ...plannedInteraction, ...overrides }],
    });
    const graphWith = (edgeType: string, modalType: string) => ({
      ...explored,
      navigationGraph: {
        ...explored.navigationGraph,
        nodes: [
          { ...explored.navigationGraph.nodes[0], modalStack: [{ type: modalType, layer: 1 }] },
        ],
        edges: [{ ...explored.navigationGraph.edges[0], edgeType }],
      },
    });
    const payloads = [
      ...["tapOn", "swipeOn"].map((action) => planned({ action })),
      ...["text", "id", "coordinates"].map((type) => planned({ target: { type, value: "v" } })),
      ...["allowed", "blocked", "unknown"].map((whitelistStatus) => planned({ whitelistStatus })),
      ...["tool", "back", "unknown"].map((edgeType) => graphWith(edgeType, "dialog")),
      ...["bottomsheet", "dialog", "popup", "menu", "overlay"].map((modal) =>
        graphWith("tool", modal),
      ),
    ];
    expect(payloads.filter((payload) => !exploreResultSchema.safeParse(payload).success)).toEqual(
      [],
    );
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

  test.each([
    [
      "completed",
      { ...explored, explorationPath: Array.from({ length: 10_000 }, (_, i) => `Screen${i}`) },
    ],
    [
      "dry run",
      {
        ...dryRun,
        plannedInteractions: Array.from({ length: 1_000 }, (_, i) => ({
          ...plannedInteraction,
          order: i,
        })),
      },
    ],
  ] as const)(
    "explore keeps a spilled %s response valid against its advertised schema",
    (_label, payload) => {
      const spilled = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "explore",
        outputSchema: exploreResultSchema,
        artifactWriter: new FakeArtifactWriter(),
      }).structuredContent as Record<string, unknown>;
      expect(spilled.artifact).toBeDefined();
      expect(["message", "success", "durationMs"].filter((key) => !(key in spilled))).toEqual([]);
      expect(validateExplore(spilled)).toBe(true);
    },
  );
});
