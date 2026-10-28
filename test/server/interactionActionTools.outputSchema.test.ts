import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { z } from "zod/v4";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import {
  clipboardResultSchema,
  dragAndDropResultSchema,
  homeScreenResultSchema,
  pinchOnResultSchema,
  recentAppsResultSchema,
  selectAllTextResultSchema,
  shakeResultSchema,
  systemTrayResultSchema,
} from "../../src/server/interactionToolOutputSchemas";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../fakes/FakeArtifactWriter";
import { advertisedOutputSchema, jsonSchemaObjects } from "../helpers/advertisedOutputSchemas";
import { compileAjv2020 } from "../helpers/jsonSchemaCompile";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const notification = {
  id: "0|com.example|1",
  appId: "com.example",
  appLabel: "Example",
  title: "Hello",
  body: null,
  actions: [],
  texts: ["Hello"],
  inGroup: false,
  ownership: "header",
};

/** One success and one failure payload per tool, as its handler builds them. */
const payloads: Array<[string, z.ZodType, Record<string, unknown>, Record<string, unknown>]> = [
  [
    "selectAllText",
    selectAllTextResultSchema,
    { message: "Selected all text in focused input field", success: true },
    { message: "Failed to select all text: none", success: false, error: "none" },
  ],
  [
    "pinchOn",
    pinchOnResultSchema,
    {
      message: "Pinched out",
      success: true,
      direction: "out",
      distanceStart: 100,
      distanceEnd: 300,
      duration: 300,
      centerX: 540,
      centerY: 960,
      targetType: "container",
      container: { elementId: "map" },
      a11yTotalTimeMs: 12,
    },
    { message: "scale must be positive", success: false, error: "scale must be positive" },
  ],
  [
    "dragAndDrop",
    dragAndDropResultSchema,
    { message: "Dragged element to target", success: true, duration: 600, distance: 420 },
    {
      message: "Failed to drag element to target: not found",
      success: false,
      error: "not found",
      containerFailure: { level: 0, reason: "not-found", selector: { text: "List" } },
    },
  ],
  [
    "shake",
    shakeResultSchema,
    { message: "Shook device for 500ms with intensity 50", success: true, duration: 500 },
    {
      message: "Failed to shake device: restore failed",
      success: false,
      error: "restore failed",
      restoreError: "restore failed",
    },
  ],
  [
    "recentApps",
    recentAppsResultSchema,
    { message: "Opened recent apps", success: true, method: "hardware" },
    { message: "Failed to open recent apps: down", success: false, error: "down" },
  ],
  [
    "homeScreen",
    homeScreenResultSchema,
    { message: "Already on the home screen", success: true, navigationMethod: "gesture" },
    { message: "Pressed home button", success: false, error: "Runner failed to press Home" },
  ],
  [
    "clipboard",
    clipboardResultSchema,
    { message: "Retrieved empty clipboard (via adb)", success: true, action: "get", method: "adb" },
    { message: "Failed", success: false, action: "copy", error: "Text is required" },
  ],
  [
    "systemTray",
    systemTrayResultSchema,
    {
      message: "Tapped notification",
      success: true,
      settled: true,
      match: { title: { text: "Hello", matchType: "exact" } },
      tapTarget: { text: "Hello", matchType: "partial", bounds: [0, 100, 1080, 200] },
      notifications: [notification],
      unattributedRows: 0,
      order: "encounter",
    },
    {
      message: "Cleared 1 of 2 notification(s)",
      success: false,
      dismissedCount: 1,
      expectedCount: 2,
      remainingCount: 1,
      arrivedCount: 1,
      stalled: true,
    },
  ],
];

// Compiling the observation-bearing schemas costs ~100ms each; do it once, outside test timing.
const validators = new Map<z.ZodType, ReturnType<typeof compileAjv2020>>();
beforeAll(() => {
  for (const [, schema] of payloads) {
    validators.set(schema, compileAjv2020(advertisedOutputSchema(schema, "ref")));
  }
});

describe("interaction action tool output schemas", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerInteractionTools();
  });
  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test.each(payloads)("%s declares its outputSchema", (name, schema) => {
    expect(ToolRegistry.getRegisteredTool(name)?.outputSchema).toBe(schema);
  });

  // Clipboard carries no observation, so nothing in its schema is shared across fields.
  // The others share the canonical observation schema, advertised as resolvable local refs.
  test("clipboard advertises its outputSchema without a $ref", () => {
    const refs = jsonSchemaObjects(advertisedOutputSchema(clipboardResultSchema, "ref")).filter(
      (node) => "$ref" in node,
    );
    expect(refs).toEqual([]);
  });

  test.each(payloads)(
    "%s advertised schema accepts its success and failure payloads",
    (_name, schema, success, failure) => {
      const validate = validators.get(schema)!;
      expect([validate(success), validate(failure)]).toEqual([true, true]);
      expect([schema.safeParse(success).success, schema.safeParse(failure).success]).toEqual([
        true,
        true,
      ]);
    },
  );

  test.each(payloads)("%s requires message and success", (_name, schema, success) => {
    for (const key of ["message", "success"]) {
      const missing = Object.fromEntries(
        Object.entries(success).filter(([field]) => field !== key),
      );
      expect(schema.safeParse(missing).success).toBe(false);
    }
  });

  test.each([
    ["pinchOn", pinchOnResultSchema, { direction: "sideways" }],
    ["dragAndDrop", dragAndDropResultSchema, { containerFailure: { level: 0, reason: "gone" } }],
    ["recentApps", recentAppsResultSchema, { method: "swipe" }],
    ["homeScreen", homeScreenResultSchema, { navigationMethod: "voice" }],
    ["clipboard", clipboardResultSchema, { action: "cut" }],
    [
      "systemTray",
      systemTrayResultSchema,
      { notifications: [{ ...notification, ownership: "guess" }] },
    ],
    ["systemTray", systemTrayResultSchema, { order: "posted" }],
  ] as const)("%s rejects an out-of-contract field", (_name, schema, field) => {
    expect(schema.safeParse({ message: "m", success: true, action: "get", ...field }).success).toBe(
      false,
    );
  });

  // The client validates only successful results on the wire, so every documented value
  // is pinned here, failures included.
  test.each([
    ["pinchOn", pinchOnResultSchema, "direction", ["in", "out"]],
    ["pinchOn", pinchOnResultSchema, "targetType", ["screen", "container"]],
    ["recentApps", recentAppsResultSchema, "method", ["hardware", "ios_swipe"]],
    ["homeScreen", homeScreenResultSchema, "navigationMethod", ["gesture", "hardware", "element"]],
    ["clipboard", clipboardResultSchema, "action", ["copy", "paste", "clear", "get"]],
    ["clipboard", clipboardResultSchema, "method", ["a11y", "adb"]],
  ] as const)("%s accepts every %s value", (_name, schema, field, values) => {
    expect(
      values.filter(
        (value) =>
          !schema.safeParse({ message: "m", success: false, action: "get", [field]: value })
            .success,
      ),
    ).toEqual([]);
  });

  test("systemTray accepts every ownership and match type", () => {
    const tray = (ownership: string, matchType: string) => ({
      message: "m",
      success: true,
      match: { body: { text: "Hi", matchType } },
      tapTarget: { text: "Hi", matchType },
      notifications: [{ ...notification, ownership }],
    });
    expect(
      [tray("header", "exact"), tray("dumpsys", "partial")].map(
        (payload) => systemTrayResultSchema.safeParse(payload).success,
      ),
    ).toEqual([true, true]);
  });

  test("clipboard requires its action", () => {
    expect(clipboardResultSchema.safeParse({ message: "m", success: true }).success).toBe(false);
  });

  test.each(payloads)(
    "%s keeps a spilled response valid against its advertised schema",
    (name, _schema, success) => {
      const outputSchema = ToolRegistry.getRegisteredTool(name)!.outputSchema!;
      const spilled = finalizeToolResponse(
        createStructuredToolResponse({
          ...success,
          warnings: Array.from({ length: 10_000 }, (_, i) => `warning ${i}`),
        }),
        { name, outputSchema, artifactWriter: new FakeArtifactWriter() },
      ).structuredContent as Record<string, unknown>;
      expect(spilled.artifact).toBeDefined();
      expect(validators.get(outputSchema)!(spilled)).toBe(true);
    },
  );
});
