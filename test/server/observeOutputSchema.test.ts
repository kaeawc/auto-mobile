import { describe, expect, test } from "bun:test";
import { toJSONSchema } from "zod/v4";
import {
  elementSchema,
  observeResultSchema,
  observeToolResultSchema,
  viewHierarchyNodeSchema,
} from "../../src/server/toolOutputSchemas";
import {
  advertiseBoundsForCompact,
  BOUNDS_UNION_DESCRIPTION_PREFIX,
} from "../../src/server/compactBoundsAdvertisement";
import { flattenTopLevelUnion } from "../../src/server/TopLevelUnionFlattener";
import { sanitizeObserveResult } from "../../src/features/observe/output/ObserveResultOutput";
import {
  loadAndroidHomeObserve,
  loadIosFractionalObserve,
} from "../fixtures/observe/observeFixture";
import { ToolRegistry, toolHasOutputSchema } from "../../src/server/toolRegistry";
import { registerObserveTools } from "../../src/server/observeTools";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { ObservationInsets } from "../../src/models/ObservationInsets";

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

describe("observeResultSchema: parses real captures (#3025)", () => {
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
    // The `skeleton` projection field (#4388) carries a deliberately always-tuple
    // bounds — it is emitted only under project:"skeleton" and its bounds never
    // depend on --observe-result-compact — so it is not a collapsible bounds
    // *union*. Exclude it structurally before asserting the union-collapse invariant.
    const properties = out.properties as Record<string, unknown> | undefined;
    if (properties) {
      delete properties.skeleton;
    }
    const json = JSON.stringify(out);
    expect(json).not.toContain("prefixItems");
    // The collapsed object arm preserves the union's description, so the prose
    // still documents the positional tuple order.
    expect(json).toContain("left, top, right, bottom");
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
