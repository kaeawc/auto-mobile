import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { registerObserveTools } from "../../src/server/observeTools";
import { identifyInteractionsResultSchema } from "../../src/server/toolOutputSchemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import { advertisedOutputSchema, jsonSchemaObjects } from "../helpers/advertisedOutputSchemas";
import { compileAjv2020 } from "../helpers/jsonSchemaCompile";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const interaction = {
  id: "interaction-1",
  type: "navigation",
  description: "Settings navigation",
  confidence: 0.9,
  suggestedToolCall: { tool: "tapOn", params: { text: "Settings", action: "tap" } },
  predictedOutcome: { type: "screen_change", destination: "Settings", confidence: 0.8 },
  element: {
    resourceId: "com.example:id/settings",
    text: "Settings",
    className: "android.widget.Button",
    bounds: { left: 0, top: 100, right: 200, bottom: 160 },
  },
};

const identified = {
  success: true,
  screenName: "Home",
  interactions: [interaction],
  summary: {
    totalInteractable: 1,
    byType: { navigation: 1 },
    navigationOptions: 1,
    inputFields: 0,
  },
};

const unobserved = {
  success: false,
  screenName: "UnknownScreen",
  interactions: [],
  summary: { totalInteractable: 0, byType: {}, navigationOptions: 0, inputFields: 0 },
  error: "No observation available. Call the 'observe' tool first to capture screen state.",
};

const withInteraction = (overrides: Record<string, unknown>) => ({
  ...identified,
  interactions: [{ ...interaction, ...overrides }],
});

let validate: ReturnType<typeof compileAjv2020>;
let previousDebugMode = false;
beforeAll(() => {
  validate = compileAjv2020(advertisedOutputSchema(identifyInteractionsResultSchema, "ref"));
  // identifyInteractions is registered in debug mode only.
  previousDebugMode = isDebugModeEnabled();
  setDebugModeEnabled(true);
});
afterAll(() => setDebugModeEnabled(previousDebugMode));

describe("identifyInteractions output schema", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerObserveTools();
  });
  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("declares its outputSchema", () => {
    expect(ToolRegistry.getRegisteredTool("identifyInteractions")?.outputSchema).toBe(
      identifyInteractionsResultSchema,
    );
  });

  // A schema instance shared across fields is advertised as a `$ref`.
  test("advertises its outputSchema without a $ref", () => {
    const refs = jsonSchemaObjects(
      advertisedOutputSchema(identifyInteractionsResultSchema, "ref"),
    ).filter((node) => "$ref" in node);
    expect(refs).toEqual([]);
  });

  test.each([
    ["identified", identified],
    ["no-observation", unobserved],
    ["compact-bounds", withInteraction({ element: { className: "B", bounds: [0, 1, 2, 3] } })],
    // Context opt-outs drop the element details, suggested call and predicted outcome.
    [
      "bare",
      {
        ...identified,
        interactions: [{ id: "i", type: "action", description: "Action", confidence: 0.5 }],
      },
    ],
  ])("advertised schema accepts a %s payload", (_label, payload) => {
    expect([
      validate(payload),
      identifyInteractionsResultSchema.safeParse(payload).success,
    ]).toEqual([true, true]);
  });

  test.each([["identified", identified] as const, ["no-observation", unobserved] as const])(
    "requires every field but error on a %s payload",
    (_label, payload) => {
      expect(
        ["success", "screenName", "interactions", "summary"].filter(
          (key) =>
            identifyInteractionsResultSchema.safeParse(
              Object.fromEntries(Object.entries(payload).filter(([field]) => field !== key)),
            ).success,
        ),
      ).toEqual([]);
    },
  );

  test.each([
    ["an unknown interaction type", withInteraction({ type: "hover" })],
    [
      "an unknown suggested tool",
      withInteraction({ suggestedToolCall: { tool: "tapAt", params: {} } }),
    ],
    [
      "an unknown outcome type",
      withInteraction({ predictedOutcome: { type: "crash", confidence: 0.1 } }),
    ],
    ["an element without a class", withInteraction({ element: { bounds: [0, 0, 1, 1] } })],
  ])("rejects %s", (_label, payload) => {
    expect(identifyInteractionsResultSchema.safeParse(payload).success).toBe(false);
  });

  // The client does not validate isError results, so every documented value is pinned here.
  test("accepts every documented enum value", () => {
    const payloads = [
      ...["navigation", "input", "action", "scroll", "toggle"].map((type) =>
        withInteraction({ type }),
      ),
      ...["tapOn", "swipeOn"].map((tool) =>
        withInteraction({ suggestedToolCall: { tool, params: {} } }),
      ),
      ...["screen_change", "dialog", "expansion", "unknown"].map((type) =>
        withInteraction({ predictedOutcome: { type, confidence: 0.5 } }),
      ),
    ];
    expect(
      payloads.filter((payload) => !identifyInteractionsResultSchema.safeParse(payload).success),
    ).toEqual([]);
  });

  test("keeps a spilled response valid against its advertised schema", () => {
    const spilled = finalizeToolResponse(
      createStructuredToolResponse({
        ...identified,
        interactions: Array.from({ length: 1_000 }, (_, i) => ({ ...interaction, id: `i-${i}` })),
      }),
      {
        name: "identifyInteractions",
        outputSchema: identifyInteractionsResultSchema,
        artifactWriter: new FakeArtifactWriter(),
      },
    ).structuredContent as Record<string, unknown>;
    expect(spilled.artifact).toBeDefined();
    expect(validate(spilled)).toBe(true);
  });
});
