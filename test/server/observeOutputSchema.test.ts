import { describe, expect, test } from "bun:test";
import { toJSONSchema } from "zod";
import {
  observeResultSchema,
  viewHierarchyNodeSchema,
} from "../../src/server/toolOutputSchemas";
import {
  advertiseBoundsForCompact,
  BOUNDS_UNION_DESCRIPTION_PREFIX,
} from "../../src/server/compactBoundsAdvertisement";
import { flattenTopLevelUnion } from "../../src/server/TopLevelUnionFlattener";
import { sanitizeObserveResult } from "../../src/features/observe/output/ObserveResultOutput";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { ToolRegistry, toolHasOutputSchema } from "../../src/server/toolRegistry";
import { registerObserveTools } from "../../src/server/observeTools";
import { serverConfig } from "../../src/utils/ServerConfig";

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
});

describe("viewHierarchyNodeSchema: polymorphic node + bounds union (#3025)", () => {
  test("accepts a node whose `node` child is a single object", () => {
    const node = { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, node: { bounds: [1, 2, 3, 4] } };
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
    const node = { "$": { class: "android.widget.TextView" }, "view-id": "id/foo", "occlusionState": "none" };
    const parsed = viewHierarchyNodeSchema.parse(node) as Record<string, unknown>;
    expect(parsed["$"]).toEqual({ class: "android.widget.TextView" });
    expect(parsed["view-id"]).toBe("id/foo");
  });
});

describe("observeResultSchema: every bounds site is the advertised union (#3025)", () => {
  const observeJson = () => flattenTopLevelUnion(toJSONSchema(observeResultSchema));

  test("the advertised schema documents the tuple order machine-readably", () => {
    const json = JSON.stringify(observeJson());
    expect(json).toContain("left, top, right, bottom");
    expect(json.toLowerCase()).toContain("observe-result-compact");
  });

  test("carries at least one bounds union (routed through elementBoundsSchema)", () => {
    expect(collectBoundsUnions(observeJson()).length).toBeGreaterThan(0);
  });

  test("compact ON: the object|tuple union (prefixItems) is advertised", () => {
    const out = advertiseBoundsForCompact(observeJson(), true);
    expect(JSON.stringify(out)).toContain("prefixItems");
  });

  test("compact OFF: every bounds union collapses to its object arm (no tuple)", () => {
    const out = advertiseBoundsForCompact(observeJson(), false);
    const json = JSON.stringify(out);
    expect(json).not.toContain("prefixItems");
    // Prose still documents the tuple exists under the flag.
    expect(json.toLowerCase()).toContain("observe-result-compact");
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
        const observe = ToolRegistry.getToolDefinitions().find(t => t.name === "observe");
        expect(observe).toBeDefined();
        expect((observe as Record<string, unknown>).outputSchema).toBeDefined();
      });
    } finally {
      serverConfig.setToolResultsNoStructuredContentEnabled(original);
    }
  });

  test("composes with --tool-results-no-structured-content: outputSchema suppressed", () => {
    const original = serverConfig.isToolResultsNoStructuredContentEnabled();
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    try {
      withFreshRegistry(() => {
        const observe = ToolRegistry.getToolDefinitions().find(t => t.name === "observe");
        expect(observe).toBeDefined();
        expect((observe as Record<string, unknown>).outputSchema).toBeUndefined();
      });
    } finally {
      serverConfig.setToolResultsNoStructuredContentEnabled(original);
    }
  });

  test("tracks --observe-result-compact through getToolDefinitions (object arm off, tuple on)", () => {
    const original = serverConfig.isObserveResultCompactEnabled();
    const observeSchemaJson = (): string => {
      const observe = ToolRegistry.getToolDefinitions().find(t => t.name === "observe");
      return JSON.stringify((observe as Record<string, unknown>).outputSchema);
    };
    try {
      withFreshRegistry(() => {
        serverConfig.setObserveResultCompactEnabled(false);
        expect(observeSchemaJson()).not.toContain("prefixItems");

        serverConfig.setObserveResultCompactEnabled(true);
        // Compact on: the object|tuple union (a JSON-Schema tuple → prefixItems)
        // is advertised, so a client decodes the emitted [l,t,r,b] tuple.
        expect(observeSchemaJson()).toContain("prefixItems");
      });
    } finally {
      serverConfig.setObserveResultCompactEnabled(original);
    }
  });
});
