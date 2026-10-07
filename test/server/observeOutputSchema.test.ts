import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { describe, expect, spyOn, test } from "bun:test";
import { toJSONSchema } from "zod/v4";
import {
  elementSchema,
  displayObservationSchema,
  observeDiffSchema,
  observationSummarySchema,
  observeResultSchema,
  observeToolResultSchema,
  skeletonElementSchema,
  viewHierarchyNodeSchema,
} from "../../src/server/toolOutputSchemas";
import { applyJsonSchemaOverride } from "../../src/server/toolSchemaHelpers";
import {
  advertiseBoundsForCompact,
  BOUNDS_UNION_DESCRIPTION_PREFIX,
} from "../../src/server/compactBoundsAdvertisement";
import { flattenTopLevelUnion } from "../../src/server/TopLevelUnionFlattener";
import {
  diffObserveResult,
  sanitizeObserveResult,
} from "../../src/features/observe/output/ObserveResultOutput";
import type { ObserveResult } from "../../src/models/ObserveResult";
import {
  loadAndroidHomeObserve,
  loadIosFractionalObserve,
} from "../fixtures/observe/observeFixture";
import { ToolRegistry, toolHasOutputSchema } from "../../src/server/toolRegistry";
import { registerObserveTools } from "../../src/server/observeTools";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { ObservationInsets } from "../../src/models/ObservationInsets";
import { consumeSetupTiming, storeSetupTiming } from "../../src/server/ToolExecutionContext";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import type { TimingData, TimingEntry } from "../../src/utils/PerformanceTracker";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";

isolateToolRegistry();

describe("observe setup timing composition", () => {
  const setup: TimingEntry = { name: "setup", durationMs: 5 };
  const connect: TimingEntry = { name: "connect", durationMs: 2 };
  const observe: TimingEntry = { name: "observe", durationMs: 3 };
  const cases: Array<{
    name: string;
    setupTiming?: TimingData;
    observeTiming?: TimingData;
    expected?: TimingData;
  }> = [
    {
      name: "array setup and array observe produce flat entries",
      setupTiming: [setup, connect],
      observeTiming: [observe],
      expected: [setup, connect, observe],
    },
    {
      name: "record setup and array observe produce flat entries",
      setupTiming: { setup, connect },
      observeTiming: [observe],
      expected: [setup, connect, observe],
    },
    {
      name: "array setup and record observe do not throw",
      setupTiming: [setup],
      observeTiming: { observe },
      expected: [setup, observe],
    },
    {
      name: "record setup and record observe do not throw",
      setupTiming: { setup },
      observeTiming: { observe },
      expected: [setup, observe],
    },
    { name: "setup alone stays flat", setupTiming: [setup], expected: [setup] },
    { name: "no setup preserves observe timing", observeTiming: [observe], expected: [observe] },
    { name: "no timing leaves the field absent" },
  ];

  test.each(cases)("$name", async ({ setupTiming, observeTiming, expected }) => {
    const device = { deviceId: "observe-timing-unit", name: "Fake", platform: "ios" } as const;
    const timer = new FakeTimer();
    const screen = new FakeObserveScreen();
    const result = structuredClone(loadIosFractionalObserve());
    delete result.backStack;
    delete result.perfTiming;
    if (observeTiming) {
      result.perfTiming = observeTiming;
    }
    screen.setObserveResult(result);
    const notify = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockResolvedValue(undefined);
    try {
      if (setupTiming) {
        storeSetupTiming(device.deviceId, setupTiming);
      }
      registerObserveTools({
        timer,
        pathProtection: new FakeScreenshotPathProtection(timer),
        createScreen: () => ({
          execute: screen.execute.bind(screen),
          executeDeviceRead: screen.execute.bind(screen),
          captureScreenshot: screen.captureScreenshot.bind(screen),
          appendRawViewHierarchy: screen.appendRawViewHierarchy.bind(screen),
          getMostRecentCachedObserveResult: screen.getMostRecentCachedObserveResult.bind(screen),
        }),
      });
      const tool = ToolRegistry.getTool("observe")!;
      const response = await tool.deviceAwareHandler!(device, tool.schema.parse({}));
      if (expected) {
        expect(response.structuredContent).toHaveProperty("perfTiming", expected);
      } else {
        expect(response.structuredContent).not.toHaveProperty("perfTiming");
      }
      if (!setupTiming && observeTiming) {
        expect(result.perfTiming).toBe(observeTiming);
      }
      expect(consumeSetupTiming(device.deviceId)).toBeNull();
    } finally {
      consumeSetupTiming(device.deviceId);
      notify.mockRestore();
      ToolRegistry.unregister("observe");
      ToolRegistry.unregister("identifyInteractions");
    }
  });
});

describe("windowTruncations output schemas", () => {
  const windowTruncations = [
    { windowId: 67, package: "com.android.systemui", reasons: ["future_code"] },
  ];
  test.each([
    { name: "observe", schema: observeResultSchema, base: {} },
    { name: "action observation", schema: observationSummarySchema, base: {} },
    {
      name: "diff",
      schema: observeDiffSchema,
      base: { isDiff: true, skeleton: [], added: [], removed: [], changed: [] },
    },
    {
      name: "display",
      schema: displayObservationSchema,
      base: {
        display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
        screenSize: { width: 1080, height: 2400 },
        freshness: { isFresh: true },
      },
    },
  ])("windowTruncations is typed and advertised in $name", ({ schema, base }) => {
    expect(schema.safeParse({ ...base, windowTruncations }).success).toBe(true);
    expect(schema.safeParse(base).success).toBe(true);
    expect(
      schema.safeParse({ ...base, windowTruncations: [{ windowId: 67, reasons: "max_nodes" }] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...base, windowTruncations: [{ windowId: "67", reasons: [] }] }).success,
    ).toBe(false);
    expect(JSON.stringify(toJSONSchema(schema))).toContain('"windowTruncations"');
  });

  test("windowTruncations full hierarchy wire reasons are advertised, optional, and nullish", () => {
    const { observe } = loadAndroidHomeObserve();
    expect(observeResultSchema.safeParse(observe).success).toBe(true);
    observe.viewHierarchy!.windows![0].truncationReasons = null;
    expect(observeResultSchema.safeParse(observe).success).toBe(true);
    observe.viewHierarchy!.windows![0].truncationReasons = ["future_code"];
    expect(observeResultSchema.safeParse(observe).success).toBe(true);
    expect(JSON.stringify(toJSONSchema(observeResultSchema))).toContain("Per-window capture");
    const malformed: unknown = {
      ...observe,
      viewHierarchy: {
        ...observe.viewHierarchy,
        windows: [{ ...observe.viewHierarchy!.windows![0], truncationReasons: [42] }],
      },
    };
    expect(observeResultSchema.safeParse(malformed).success).toBe(false);
  });
});

/**
 * `observe` outputSchema coverage (issue #3025). The headline `observe` tool had
 * no `outputSchema`, so it advertised nothing machine-readable on the wire —
 * including the `--observe-result-compact` bounds tuple, of which observe (its
 * hierarchy nodes, window/root/region, and `elements`) produces the bulk. These
 * tests pin that `observe` now advertises an `ObserveResult` schema whose every
 * `bounds` field routes through `elementBoundsSchema`, so the compact tuple is
 * flag-advertised there too via the existing `advertiseBoundsForCompact` hook.
 */

/** Depth-first collect every bounds-union node by its stable description marker. */
function collectBoundsUnions(schema: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const stack: unknown[] = [schema];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
    } else if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (
        typeof obj.description === "string" &&
        obj.description.startsWith(BOUNDS_UNION_DESCRIPTION_PREFIX)
      ) {
        found.push(obj);
      }
      stack.push(...Object.values(obj));
    }
  }
  return found;
}

const OBSERVE_JOIN_KEYS = [
  "observationId",
  "deviceId",
  "display",
  "observationScreenshotResourceUri",
] as const;
const REQUIRED_OBSERVE_JOIN_KEYS = ["observationId", "deviceId", "display"] as const;

/**
 * Evaluate the effective JSON-Schema `required` set for one instance, honoring
 * the `required` + `if`/`then`/`else` conditional shape the top-level union
 * flattener emits. `if` is matched on `required` presence and `properties.<k>.const`
 * equality, exactly as the flattener produces it. This exercises the PUBLISHED,
 * flattened schema — not the inner arm — so it catches join keys that end up
 * gated behind a branch discriminator after flattening (issue #7018).
 */
function effectiveRequired(
  schema: Record<string, unknown>,
  instanceKeys: Set<string>,
  instanceConsts: Record<string, unknown>,
  acc: Set<string> = new Set(),
): Set<string> {
  for (const key of (schema.required as string[] | undefined) ?? []) {
    acc.add(key);
  }
  const ifSchema = schema.if as Record<string, unknown> | undefined;
  if (ifSchema) {
    const matches = conditionMatches(ifSchema, instanceKeys, instanceConsts);
    const branch = (matches ? schema.then : schema.else) as Record<string, unknown> | undefined;
    if (branch) {
      effectiveRequired(branch, instanceKeys, instanceConsts, acc);
    }
  }
  return acc;
}

function conditionMatches(
  ifSchema: Record<string, unknown>,
  instanceKeys: Set<string>,
  instanceConsts: Record<string, unknown>,
): boolean {
  const required = (ifSchema.required as string[] | undefined) ?? [];
  if (!required.every((key) => instanceKeys.has(key))) {
    return false;
  }
  const properties = ifSchema.properties as Record<string, { const?: unknown }> | undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if ("const" in value && instanceConsts[key] !== value.const) {
        return false;
      }
    }
  }
  return true;
}

function publishedObserveOutputSchema(): Record<string, unknown> {
  const original = serverConfig.isToolResultsNoStructuredContentEnabled();
  serverConfig.setToolResultsNoStructuredContentEnabled(false);
  ToolRegistry.clearTools();
  try {
    registerObserveTools();
    const observe = ToolRegistry.getToolDefinitions().find((tool) => tool.name === "observe");
    const outputSchema = (observe as Record<string, unknown> | undefined)?.outputSchema;
    if (!outputSchema || typeof outputSchema !== "object") {
      throw new Error("observe tool did not advertise an outputSchema");
    }
    return outputSchema as Record<string, unknown>;
  } finally {
    ToolRegistry.clearTools();
    serverConfig.setToolResultsNoStructuredContentEnabled(original);
  }
}

describe("observe.outputSchema: requires usable screenshot-resource join keys on the wire (#7018)", () => {
  test("the PUBLISHED (flattened) schema requires identities but makes the URI optional for an ordinary successful observation", () => {
    const published = publishedObserveOutputSchema();
    // A successful observation carries no `artifact` spill key.
    const successfulKeys = new Set<string>(OBSERVE_JOIN_KEYS);
    const required = effectiveRequired(published, successfulKeys, {});
    for (const key of REQUIRED_OBSERVE_JOIN_KEYS) {
      expect(required).toContain(key);
    }
    expect(required).not.toContain("observationScreenshotResourceUri");
    expect(
      (published.properties as Record<string, unknown>).observationScreenshotResourceUri,
    ).toBeDefined();
    const display = (published.properties as Record<string, unknown>).display as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(display.required).toEqual(["key", "role", "posture", "generation"]);
    expect(Object.keys(display.properties)).toEqual([
      "key",
      "pinned",
      "role",
      "posture",
      "generation",
    ]);
  });

  test("the join-key requirement does NOT depend on accessibilityAuditSkipped being present", () => {
    const published = publishedObserveOutputSchema();
    // Without accessibilityAuditSkipped ...
    const withoutAudit = effectiveRequired(published, new Set(OBSERVE_JOIN_KEYS), {});
    // ... and with it present: same required set either way.
    const withAudit = effectiveRequired(
      published,
      new Set([...OBSERVE_JOIN_KEYS, "accessibilityAuditSkipped"]),
      { accessibilityAuditSkipped: "settled_capture_adopted" },
    );
    for (const key of REQUIRED_OBSERVE_JOIN_KEYS) {
      expect(withoutAudit).toContain(key);
      expect(withAudit).toContain(key);
    }
    expect(withoutAudit).not.toContain("observationScreenshotResourceUri");
    expect(withAudit).not.toContain("observationScreenshotResourceUri");
  });

  test("the artifact/spill arm does NOT require the join keys", () => {
    const published = publishedObserveOutputSchema();
    // The hard-ceiling spill result is `{ artifact: {...} }` with no join keys.
    const required = effectiveRequired(published, new Set<string>(["artifact"]), {});
    for (const key of OBSERVE_JOIN_KEYS) {
      expect(required).not.toContain(key);
    }
  });

  test("parse stays lenient for recorded captures that predate the fields", () => {
    // The wire contract is advertise-only; runtime parsing must still accept
    // captures missing the join keys.
    expect(() => observeResultSchema.parse({})).not.toThrow();
    expect(() =>
      observeDiffSchema.parse({ isDiff: true, skeleton: [], added: [], removed: [], changed: [] }),
    ).not.toThrow();
  });

  test("the diff schema accepts the same platform-native screenSize as a full observation (#7335)", () => {
    const diff = observeDiffSchema.parse({
      isDiff: true,
      skeleton: [],
      added: [],
      removed: [],
      changed: [],
      screenSize: { width: 393, height: 852 },
    });

    expect(diff.screenSize).toEqual({ width: 393, height: 852 });
  });

  test("the embedded diff arm requires identities while declaring the screenshot URI optional (it is nested, not top-level flattened)", () => {
    // observeDiffSchema is only ever nested (inside observationOutputSchema /
    // action-tool `.observation`), so it never hits top-level union flattening
    // and keeps its per-arm required intact. Assert that contract holds.
    const jsonSchema = toJSONSchema(observeDiffSchema) as Record<string, unknown>;
    applyJsonSchemaOverride(observeDiffSchema, jsonSchema);
    const required = Array.isArray(jsonSchema.required) ? (jsonSchema.required as string[]) : [];
    for (const key of REQUIRED_OBSERVE_JOIN_KEYS) {
      expect(required).toContain(key);
    }
    expect(required).not.toContain("observationScreenshotResourceUri");
    expect(
      (jsonSchema.properties as Record<string, unknown>).observationScreenshotResourceUri,
    ).toBeDefined();
  });
});

describe("observeResultSchema: parses real captures (#3025)", () => {
  test("snapshot reference diagnostics accept only arrays of strings across output shapes", () => {
    expect(
      observationSummarySchema.parse({ snapshotReferenceUnavailable: ["rotation"] }),
    ).toMatchObject({
      snapshotReferenceUnavailable: ["rotation"],
    });
    expect(observationSummarySchema.safeParse({ snapshotReferenceUnavailable: [1] }).success).toBe(
      false,
    );
    for (const schema of [observeResultSchema, observeDiffSchema, observeToolResultSchema]) {
      const output = {
        isDiff: true,
        skeleton: [],
        added: [],
        removed: [],
        changed: [],
        snapshotReferenceUnavailable: ["rotation"],
      };
      expect(schema.parse(output)).toMatchObject({ snapshotReferenceUnavailable: ["rotation"] });
      expect(schema.safeParse({ ...output, snapshotReferenceUnavailable: [1] }).success).toBe(
        false,
      );
      expect(
        schema.safeParse({ ...output, snapshotReferenceUnavailable: "rotation" }).success,
      ).toBe(false);
    }
  });

  test("full and skeleton projections preserve snapshot reference diagnostics", () => {
    const observation = {
      ...loadIosFractionalObserve(),
      snapshotReferenceUnavailable: ["rotation"],
    };
    for (const project of ["full", "skeleton"] as const) {
      expect(sanitizeObserveResult(observation, { dropElements: true, project })).toMatchObject({
        snapshotReferenceUnavailable: ["rotation"],
      });
    }
  });

  test("accepts full and per-entry layout-warning diff field shapes but rejects malformed arms", () => {
    const observation = (layoutWarnings?: ObserveResult["layoutWarnings"]): ObserveResult =>
      ({
        updatedAt: 1,
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        activeWindow: { appId: "com.example", activityName: ".MainActivity", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.example",
          hierarchy: {
            node: { "resource-id": "root", bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
          },
        },
        ...(layoutWarnings === undefined ? {} : { layoutWarnings }),
      }) as ObserveResult;
    const warning = {
      type: "important-content-under-inset",
      severity: "warning",
      element: { text: "Title", bounds: { left: 0, top: 0, right: 100, bottom: 30 } },
      categories: ["text"],
      insetTypes: ["safeArea"],
      sides: ["top"],
      overflowPx: { top: 30 },
      insetPx: { top: 59.5 },
      overlapPercent: 100,
      confidence: "high",
    } as const;
    const perEntry = diffObserveResult(
      observation({ scope: "truncated", total: 100, warnings: [warning] }),
      observation({ scope: "truncated", total: 140, warnings: [warning] }),
      { layoutWarningsDiffMode: "perEntry" },
    );
    const full = diffObserveResult(
      observation(),
      observation({ scope: "full", warnings: [warning] }),
    );

    expect(() => observeDiffSchema.parse(perEntry)).not.toThrow();
    expect(() => observeDiffSchema.parse(full)).not.toThrow();
    expect(() =>
      observeDiffSchema.parse({
        ...perEntry,
        fields: { layoutWarnings: { added: "not-an-array" } },
      }),
    ).toThrow();
    expect(() =>
      observeDiffSchema.parse({
        ...perEntry,
        fields: { layoutWarnings: { added: [], removed: [], unexpected: true } },
      }),
    ).toThrow();
  });

  test("models declarative waitFor outcome metadata", () => {
    expect(() =>
      observeResultSchema.parse({
        matched: false,
        timedOut: true,
        polls: 3,
        waitMs: 250,
        candidates: [
          { "resource-id": "submit", bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
        ],
      }),
    ).not.toThrow();
    expect(() => observeResultSchema.parse({ polls: -1 })).toThrow();
    expect(() => observeResultSchema.parse({ waitMs: -1 })).toThrow();
  });

  test("accepts source-attributed insets and advisory layout warnings", () => {
    const parsed = observeResultSchema.safeParse({
      screenSize: { width: 375, height: 812 },
      insets: {
        available: true,
        source: "ios-sdk-safe-area",
        units: "points",
        safeArea: { top: 59.5, right: 0, bottom: 34, left: 0 },
        systemChrome: {
          visibility: "hidden",
          statusBar: "hidden",
          homeIndicatorAutoHideRequested: true,
          source: "ios-status-bar-manager",
        },
      },
      layoutWarnings: {
        scope: "full",
        warnings: [
          {
            type: "important-content-under-inset",
            severity: "warning",
            element: { text: "Title", bounds: { top: 0, right: 100, bottom: 30, left: 0 } },
            categories: ["text"],
            insetTypes: ["safeArea"],
            sides: ["top"],
            overflowPx: { top: 30 },
            insetPx: { top: 59.5 },
            overlapPercent: 100,
            confidence: "high",
          },
        ],
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.layoutWarnings?.warnings[0]).toMatchObject({
      overflowPx: { top: 30 },
      insetPx: { top: 59.5 },
    });
    expect(parsed.data?.insets?.systemChrome).toEqual({
      visibility: "hidden",
      statusBar: "hidden",
      homeIndicatorAutoHideRequested: true,
      source: "ios-status-bar-manager",
    });
  });

  test("accepts nullable Android inset categories", () => {
    expect(() =>
      observeResultSchema.parse({
        insets: {
          available: true,
          source: "android-window-metrics",
          units: "physical-pixels",
          systemBars: {
            visible: { top: 24, right: 0, bottom: 48, left: 0 },
            stable: { top: 24, right: 0, bottom: 48, left: 0 },
          },
          displayCutout: null,
          systemGestures: null,
          mandatorySystemGestures: null,
          tappableElement: null,
          systemChrome: {
            visibility: "partial",
            statusBar: "visible",
            navigationBar: "hidden",
            homeIndicatorAutoHideRequested: null,
            source: "android-window-insets",
          },
        },
      }),
    ).not.toThrow();
  });

  test("models additive display-cutout classification and geometry", () => {
    const classifications = ["none", "notch", "dynamic_island", "hole_punch", "unknown"] as const;

    for (const classification of classifications) {
      expect(() =>
        observeResultSchema.parse({
          insets: {
            available: classification !== "unknown",
            source: classification === "unknown" ? "unavailable" : "android-window-metrics",
            units: classification === "unknown" ? "unknown" : "physical-pixels",
            displayCutoutInfo:
              classification === "none" || classification === "unknown"
                ? { classification }
                : { classification, bounds: [[420, 0, 660, 90]] },
          },
        }),
      ).not.toThrow();
    }

    expect(() =>
      observeResultSchema.parse({
        insets: {
          available: true,
          source: "android-window-metrics",
          units: "physical-pixels",
          displayCutoutInfo: { classification: "none", bounds: null },
        },
      }),
    ).not.toThrow();

    expect(() =>
      observeResultSchema.parse({
        insets: {
          available: true,
          source: "android-window-metrics",
          units: "physical-pixels",
          displayCutoutInfo: { classification: "notch", bounds: [{ left: 0, top: 0, right: 1 }] },
        },
      }),
    ).toThrow();
    expect(() =>
      observeResultSchema.parse({
        insets: {
          available: true,
          source: "android-window-metrics",
          units: "physical-pixels",
          displayCutoutInfo: { classification: "notch", bounds: [[1, 2, 3, 4, 5]] },
        },
      }),
    ).toThrow();

    const sanitized = sanitizeObserveResult(
      {
        insets: {
          available: true,
          source: "android-window-metrics",
          units: "physical-pixels",
          displayCutoutInfo: {
            classification: "hole_punch",
            bounds: [{ left: 480, top: 0, right: 600, bottom: 100 }],
          },
        },
      } as never,
      { dropElements: false, compact: true },
    );
    expect(sanitized.insets?.displayCutoutInfo?.bounds).toEqual([[480, 0, 600, 100]]);
    expect(() => observeResultSchema.parse(sanitized)).not.toThrow();
  });

  test("accepts the Android resource fallback without system-chrome visibility", () => {
    const fallbackInsets: ObservationInsets = {
      available: true,
      source: "android-resource-fallback",
      units: "physical-pixels",
      systemBars: {
        visible: { top: 24, right: 0, bottom: 48, left: 0 },
        stable: { top: 24, right: 0, bottom: 48, left: 0 },
      },
      systemChrome: null,
    };

    expect(fallbackInsets.systemChrome).toBeNull();
    expect(() =>
      observeResultSchema.parse({
        insets: {
          ...fallbackInsets,
        },
      }),
    ).not.toThrow();
  });

  test("accepts the frozen android-home observe fixture (object bounds)", () => {
    const { observe } = loadAndroidHomeObserve();
    expect(() => observeResultSchema.parse(observe)).not.toThrow();
  });

  test("accepts the compacted form (bounds flattened to tuples)", () => {
    const { observe } = loadAndroidHomeObserve();
    const compacted = sanitizeObserveResult(observe, { dropElements: false, compact: true });
    // Sanity: the fixture really does carry tuple bounds after compaction.
    const json = JSON.stringify(compacted);
    expect(json).toContain("[0,0,1080,2400]");
    expect(() => observeResultSchema.parse(compacted)).not.toThrow();
  });

  test("accepts compacted layout-warning bounds and fractional legacy iOS insets", () => {
    const observe = {
      systemInsets: { top: 59.5, right: 0, bottom: 34, left: 0 },
      layoutWarnings: {
        scope: "full",
        warnings: [
          {
            type: "important-content-under-inset",
            severity: "warning",
            element: { text: "Title", bounds: { left: 0, top: 0, right: 100, bottom: 30 } },
            categories: ["text"],
            insetTypes: ["safeArea"],
            sides: ["top"],
            overflowPx: { top: 30 },
            insetPx: { top: 59.5 },
            overlapPercent: 100,
            confidence: "high",
          },
        ],
      },
    };
    const compacted = sanitizeObserveResult(observe as never, {
      dropElements: false,
      compact: true,
    });

    expect(compacted.layoutWarnings?.warnings[0]?.element.bounds).toEqual([0, 0, 100, 30]);
    expect(() => observeResultSchema.parse(compacted)).not.toThrow();
  });

  test("caps layoutWarnings by default and opts out with capLayoutWarnings:false", () => {
    const warning = {
      type: "important-content-under-inset",
      severity: "info",
      element: { bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
      categories: ["text"],
      insetTypes: ["systemBars"],
      sides: ["top"],
      overflowPx: { top: 1 },
      insetPx: { top: 1 },
      overlapPercent: 10,
      confidence: "medium",
    };
    const observe = {
      layoutWarnings: { scope: "full", warnings: Array.from({ length: 150 }, () => warning) },
    };

    const capped = sanitizeObserveResult(observe as never, { dropElements: false });
    expect(capped.layoutWarnings?.scope).toBe("truncated");
    expect(capped.layoutWarnings?.warnings).toHaveLength(100);
    expect(capped.layoutWarnings?.total).toBe(150);

    const uncapped = sanitizeObserveResult(observe as never, {
      dropElements: false,
      capLayoutWarnings: false,
    });
    expect(uncapped.layoutWarnings?.scope).toBe("full");
    expect(uncapped.layoutWarnings?.warnings).toHaveLength(150);
  });

  test("accepts an iOS root hierarchy.bounds with optional left/top (points)", () => {
    // Hierarchy.bounds is `{left?, top?, right, bottom}` on iOS — the element
    // union (all four keys required) would wrongly reject it, so it rides
    // passthrough.
    const objectRoot = { viewHierarchy: { hierarchy: { bounds: { right: 390, bottom: 844 } } } };
    expect(() => observeResultSchema.parse(objectRoot)).not.toThrow();
    // ...and its compacted `[null, null, r, b]` tuple form is not rejected either.
    const compactedRoot = { viewHierarchy: { hierarchy: { bounds: [null, null, 390, 844] } } };
    expect(() => observeResultSchema.parse(compactedRoot)).not.toThrow();
  });

  test("accepts the iOS fractional-points fixture, object and compacted forms (#3206)", () => {
    // iOS bounds are XCUITest points — legitimately fractional. The previous
    // `z.number().int()` claim made a strict client reject such an observation.
    const observe = loadIosFractionalObserve();
    // Sanity: the fixture really does carry fractional coordinates.
    expect(JSON.stringify(observe)).toContain("786.5");
    expect(() => observeResultSchema.parse(observe)).not.toThrow();
    const compacted = sanitizeObserveResult(observe, { dropElements: false, compact: true });
    expect(() => observeResultSchema.parse(compacted)).not.toThrow();
  });

  test("routes elements.media[].bounds through the advertised union (object + tuple)", () => {
    const objectMedia = {
      elements: {
        clickable: [],
        scrollable: [],
        text: [],
        media: [{ mediaType: "image", bounds: { left: 101, top: 2144, right: 227, bottom: 2270 } }],
      },
    };
    const tupleMedia = {
      elements: {
        clickable: [],
        scrollable: [],
        text: [],
        media: [{ mediaType: "image", bounds: [101, 2144, 227, 2270] }],
      },
    };
    expect(() => observeResultSchema.parse(objectMedia)).not.toThrow();
    expect(() => observeResultSchema.parse(tupleMedia)).not.toThrow();
  });

  test("preserves unmodeled top-level fields (passthrough)", () => {
    const parsed = observeResultSchema.parse({
      screenSize: { width: 1080, height: 2400 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      backStack: { depth: 2 },
      userId: 0,
      perfTiming: [{ phase: "x", durationMs: 1 }],
      wakefulness: "Awake",
    }) as Record<string, unknown>;
    expect(parsed.backStack).toEqual({ depth: 2 });
    expect(parsed.userId).toBe(0);
    expect(parsed.perfTiming).toEqual([{ phase: "x", durationMs: 1 }]);
    expect(parsed.wakefulness).toBe("Awake");
  });

  test("models the deviceLock field, secure optional (#4235)", () => {
    const secure = observeResultSchema.parse({
      deviceLock: { locked: true, keyguardShowing: true, secure: true },
    }) as Record<string, unknown>;
    expect(secure.deviceLock).toEqual({ locked: true, keyguardShowing: true, secure: true });

    // `secure` may be omitted when it can't be determined over adb.
    const noSecure = observeResultSchema.parse({
      deviceLock: { locked: true, keyguardShowing: true },
    }) as Record<string, unknown>;
    expect(noSecure.deviceLock).toEqual({ locked: true, keyguardShowing: true });

    // A non-boolean lock flag is rejected.
    expect(() =>
      observeResultSchema.parse({ deviceLock: { locked: "yes", keyguardShowing: true } }),
    ).toThrow();
  });

  test("advertises requested scope dimensions gated off by server flags", () => {
    const schema = flattenTopLevelUnion(toJSONSchema(observeResultSchema));
    const properties = schema.properties as Record<string, unknown>;
    const observeScope = properties.observeScope as { properties: Record<string, unknown> };
    const gatedOff = observeScope.properties.gatedOff as {
      items: { enum: string[] };
    };

    expect(gatedOff.items.enum).toEqual(["focus", "region", "overview"]);
  });
});

describe("observeToolResultSchema: artifact metadata (#3480)", () => {
  test("accepts artifact metadata in place of an inline ObserveResult", () => {
    expect(() =>
      observeToolResultSchema.parse({
        artifact: {
          path: "/tmp/auto-mobile/123-observe-id.json",
          format: "json",
          payload: "ObserveResult",
          bytes: 123,
          tool: "observe",
        },
      }),
    ).not.toThrow();
  });
});

describe("viewHierarchyNodeSchema: polymorphic node + bounds union (#3025)", () => {
  test("accepts a node whose `node` child is a single object", () => {
    const node = {
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      node: { bounds: [1, 2, 3, 4] },
    };
    expect(() => viewHierarchyNodeSchema.parse(node)).not.toThrow();
  });

  test("accepts a node whose `node` child is an array (recursion)", () => {
    const node = {
      bounds: [0, 0, 10, 10],
      node: [{ bounds: { left: 1, top: 1, right: 2, bottom: 2 } }, { text: "leaf" }],
    };
    expect(() => viewHierarchyNodeSchema.parse(node)).not.toThrow();
  });

  test("keeps the polymorphic `$` attribute bag and per-node metadata", () => {
    const node = {
      $: { class: "android.widget.TextView" },
      "view-id": "id/foo",
      occlusionState: "partial",
      occludedBy: "unlabeled view",
      occludedByViewId: "id/occluder",
    };
    const parsed = viewHierarchyNodeSchema.parse(node) as Record<string, unknown>;
    expect(parsed["$"]).toEqual({ class: "android.widget.TextView" });
    expect(parsed["view-id"]).toBe("id/foo");
    expect(parsed.occlusionState).toBe("partial");
    expect(parsed.occludedBy).toBe("unlabeled view");
    expect(parsed.occludedByViewId).toBe("id/occluder");
  });

  test("advertises occlusion metadata as typed node properties", () => {
    const schemaJson = JSON.stringify(toJSONSchema(viewHierarchyNodeSchema));
    expect(schemaJson).toContain('"occlusionState"');
    expect(schemaJson).toContain('"occludedBy"');
    expect(schemaJson).toContain('"occludedByViewId"');
    expect(() =>
      viewHierarchyNodeSchema.parse({
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
        occludedByViewId: 123,
      }),
    ).toThrow();
  });
});

describe("elementSchema: occlusion link fields", () => {
  test("advertises both view-id targets and occludedByViewId references", () => {
    const schemaJson = JSON.stringify(toJSONSchema(elementSchema));
    expect(schemaJson).toContain('"view-id"');
    expect(schemaJson).toContain('"occludedByViewId"');
    expect(() =>
      elementSchema.parse({
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
        "view-id": "id/target",
        occludedByViewId: "id/occluder",
      }),
    ).not.toThrow();
    expect(() =>
      elementSchema.parse({
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
        "view-id": 123,
      }),
    ).toThrow();
  });
});

describe("observeResultSchema: every bounds site is the advertised union (#3025)", () => {
  const observeJson = () => flattenTopLevelUnion(toJSONSchema(observeResultSchema));

  test("the advertised schema documents the tuple order machine-readably", () => {
    const json = JSON.stringify(observeJson());
    // Bounds compaction is a permanent default now; the tuple order is documented
    // as the default form so a client can decode [l,t,r,b] from the schema alone.
    expect(json).toContain("left, top, right, bottom");
  });

  test("carries at least one bounds union (routed through elementBoundsSchema)", () => {
    expect(collectBoundsUnions(observeJson()).length).toBeGreaterThan(0);
  });

  test("compact ON: the object|tuple union (prefixItems) is advertised", () => {
    const out = advertiseBoundsForCompact(observeJson(), true);
    expect(JSON.stringify(out)).toContain("prefixItems");
  });

  test("compact OFF: every bounds union collapses to its object arm (no tuple)", () => {
    const out = advertiseBoundsForCompact(observeJson(), false) as Record<string, unknown>;
    // The `skeleton` projection field (#4388) — and its sibling `context` array
    // (issue #6221 item 1), same row shape — carry a deliberately always-tuple
    // bounds: emitted only under project:"skeleton" and never dependent on
    // --observe-result-compact, so neither is a collapsible bounds *union*.
    // Exclude both structurally before asserting the union-collapse invariant.
    const properties = out.properties as Record<string, unknown> | undefined;
    if (properties) {
      delete properties.skeleton;
      delete properties.context;
      // The opt-in per-panel projection has the same always-tuple rows.
      const displayProperties = (
        properties.displays as
          | {
              items?: { properties?: Record<string, unknown> };
            }
          | undefined
      )?.items?.properties;
      if (displayProperties) {
        delete displayProperties.skeleton;
        delete displayProperties.context;
      }
    }
    const json = JSON.stringify(out);
    expect(json).not.toContain("prefixItems");
    // The collapsed object arm preserves the union's description, so the prose
    // still documents the positional tuple order.
    expect(json).toContain("left, top, right, bottom");
  });
});

describe("observe skeleton IME occlusion", () => {
  test("parses an occluded context row through the row and observe output schemas", () => {
    const row = {
      elementId: "id/covered",
      bounds: [0, 400, 200, 500] as [number, number, number, number],
      affordances: [],
      occluded: true,
    } as const;
    expect(skeletonElementSchema.parse(row).occluded).toBe(true);
    expect(observeToolResultSchema.parse({ context: [row] })).toMatchObject({
      context: [{ occluded: true }],
    });
  });

  test("advertises the occluded field on skeleton rows", () => {
    const published = publishedObserveOutputSchema();
    const serialized = JSON.stringify(published);
    expect(serialized).toContain('"occluded"');
    expect(serialized).toContain("Fully covered by the Android IME window");
  });
});

describe("observe tool registration advertises the schema (#3025)", () => {
  const withFreshRegistry = <T>(fn: () => T): T => {
    ToolRegistry.clearTools();
    try {
      registerObserveTools();
      return fn();
    } finally {
      ToolRegistry.clearTools();
    }
  };

  test("the registered observe tool declares an outputSchema", () => {
    withFreshRegistry(() => {
      const tool = ToolRegistry.getTool("observe");
      expect(tool).toBeDefined();
      expect(toolHasOutputSchema(tool!)).toBe(true);
    });
  });

  test("tools/list advertises observe.outputSchema when structured content is on", () => {
    const original = serverConfig.isToolResultsNoStructuredContentEnabled();
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    try {
      withFreshRegistry(() => {
        const observe = ToolRegistry.getToolDefinitions().find((t) => t.name === "observe");
        expect(observe).toBeDefined();
        expect((observe as Record<string, unknown>).outputSchema).toBeDefined();
      });
    } finally {
      serverConfig.setToolResultsNoStructuredContentEnabled(original);
    }
  });

  test("tools/list advertises observe artifact metadata shape", () => {
    withFreshRegistry(() => {
      const observe = ToolRegistry.getToolDefinitions().find((t) => t.name === "observe");
      expect(JSON.stringify((observe as Record<string, unknown>).outputSchema)).toContain(
        '"artifact"',
      );
      expect(JSON.stringify((observe as Record<string, unknown>).outputSchema)).toContain(
        '"payload"',
      );
    });
  });

  test("composes with --tool-results-no-structured-content: outputSchema suppressed", () => {
    const original = serverConfig.isToolResultsNoStructuredContentEnabled();
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    try {
      withFreshRegistry(() => {
        const observe = ToolRegistry.getToolDefinitions().find((t) => t.name === "observe");
        expect(observe).toBeDefined();
        expect((observe as Record<string, unknown>).outputSchema).toBeUndefined();
      });
    } finally {
      serverConfig.setToolResultsNoStructuredContentEnabled(original);
    }
  });

  test("advertises the bounds tuple through getToolDefinitions (compaction is a permanent default)", () => {
    const observeSchemaJson = (): string => {
      const observe = ToolRegistry.getToolDefinitions().find((t) => t.name === "observe");
      return JSON.stringify((observe as Record<string, unknown>).outputSchema);
    };
    // Count JSON-Schema tuple sites (`prefixItems`). Bounds compaction is now
    // unconditional, so the object|tuple union is advertised for every bounds
    // field — plus the always-tuple `skeleton` bounds (#4388). A client can
    // therefore always decode the emitted [l,t,r,b] tuple. There is no flag to
    // flip: the advertised schema carries multiple tuple sites unconditionally.
    const countTupleSites = (json: string): number => json.split("prefixItems").length - 1;
    withFreshRegistry(() => {
      const sites = countTupleSites(observeSchemaJson());
      expect(sites).toBeGreaterThan(1);
    });
  });

  test("advertises the skeleton projection field with an always-tuple bounds (#4388)", () => {
    withFreshRegistry(() => {
      const observe = ToolRegistry.getToolDefinitions().find((t) => t.name === "observe");
      const json = JSON.stringify((observe as Record<string, unknown>).outputSchema);
      expect(json).toContain('"skeleton"');
      expect(json).toContain('"affordances"');
      expect(json).toContain('"semanticLinks"');
      expect(json).toContain('"testTag"');
      // Hoisted secondary state text (#5869) is advertised like its siblings.
      expect(json).toContain('"sublabel"');
    });
  });
});

describe("occlusionState/occludedBy/occludedByViewId: --no-occlusion (issue occlusion-flag)", () => {
  // These node properties are always optional in the schema (see viewHierarchyNodeSchema tests
  // above) — the APK only computes and sends them at all when occlusionEnabled is true, so the
  // meaningful "present by default, absent when disabled" behavior lives in ServerConfig, which is
  // what actually gets pushed to the device over the set_accessibility_flags message.
  // Issue #4181, rank 13 (R3): the previous body was a set-then-assert
  // tautology (setOcclusionEnabled(true) then expect(true)) — it could never
  // catch the default at ServerConfig.ts:38 flipping to false. Read the genuine
  // default from a FRESH, query-suffixed module import so the shared singleton's
  // possibly-polluted state cannot mask a regression.
  test("occlusion is enabled by default (read from a pristine ServerConfig instance)", async () => {
    // Pollute the shared singleton to prove the fresh import is independent.
    serverConfig.setOcclusionEnabled(false);
    try {
      const fresh = await import("../../src/utils/ServerConfig?occlusionDefault");
      expect(fresh.serverConfig.getAccessibilityFlagsConfig().occlusionEnabled).toBe(true);
    } finally {
      serverConfig.setOcclusionEnabled(true);
    }
  });

  test("--no-occlusion disables occlusion via ServerConfig", () => {
    const original = serverConfig.getAccessibilityFlagsConfig().occlusionEnabled;
    try {
      serverConfig.setOcclusionEnabled(false);
      expect(serverConfig.getAccessibilityFlagsConfig().occlusionEnabled).toBe(false);
    } finally {
      serverConfig.setOcclusionEnabled(original);
    }
  });

  test("occlusion node properties remain optional in the schema regardless of the flag", () => {
    // Schema shape doesn't change with the flag — a client observing an older daemon or a
    // hierarchy captured before occlusion was disabled must still be able to parse these fields.
    expect(() =>
      viewHierarchyNodeSchema.parse({ bounds: { left: 0, top: 0, right: 1, bottom: 1 } }),
    ).not.toThrow();
    expect(() =>
      viewHierarchyNodeSchema.parse({
        bounds: { left: 0, top: 0, right: 1, bottom: 1 },
        occlusionState: "partial",
        occludedBy: "unlabeled view",
        occludedByViewId: "id/occluder",
      }),
    ).not.toThrow();
  });
});

test("observe advertises an optional boolean for a service started by a device read", () => {
  const schema = toJSONSchema(observeResultSchema);
  expect(schema.properties?.hierarchyServiceStarted).toMatchObject({ type: "boolean" });
  expect(schema.required ?? []).not.toContain("hierarchyServiceStarted");
  expect(observeToolResultSchema.safeParse({ hierarchyServiceStarted: true }).success).toBe(true);
  expect(observeToolResultSchema.safeParse({ hierarchyServiceStarted: "true" }).success).toBe(
    false,
  );
});

describe("observe synthetic id lifetime", () => {
  test("advertises capture-local ids in the schema and tool description", () => {
    const description = skeletonElementSchema.shape.elementId.description;
    expect(description).toContain("s2-");
    expect(description).toContain("valid only for the observation that returned them");
    expect(elementSchema.shape["view-id"].description).toBe(description);
    expect(JSON.stringify(toJSONSchema(viewHierarchyNodeSchema))).toContain(description!);
    registerObserveTools();
    expect(ToolRegistry.getTool("observe")?.description).toContain(
      "valid only for the observation that returned them",
    );
  });
});
