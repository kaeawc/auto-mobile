import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import {
  encodeObserveCompact,
  sanitizeObserveResult,
  OBSERVE_COMPACT_LEGEND,
} from "../../../../src/features/observe/output/ObserveResultOutput";
import { decodeToonTable } from "../../../../src/utils/toon";
import {
  loadAndroidHomeObserve,
  measureValue,
} from "../../../fixtures/observe/observeFixture";

/**
 * Tests for the `--observe-result-compact` text encoder (issue #2760).
 *
 * Format contract:
 *  - line 1 is the self-describing legend.
 *  - line 2 is compact (no-indent) JSON of the payload with `elements` detached
 *    (the ragged `viewHierarchy` tree stays inline as JSON — highest escaping
 *    risk, least TOON benefit).
 *  - the uniform `elements.*` arrays follow as TOON blocks.
 *  - the transform is pure: the input `ObserveResult` is never mutated.
 */

/** Split the compact text into { legend, treeJson, toonBlocks-by-name }. */
function parseCompact(text: string): {
  legend: string;
  tree: Record<string, unknown>;
  blocks: Record<string, ReturnType<typeof decodeToonTable>>;
} {
  const lines = text.split("\n");
  const legend = lines[0];
  const tree = JSON.parse(lines[1]) as Record<string, unknown>;
  const blocks: Record<string, ReturnType<typeof decodeToonTable>> = {};
  // Everything from line 2 onward is TOON; re-join and split on header lines.
  const rest = lines.slice(2).join("\n");
  // Header lines look like `name[count]{...}:` at column 0.
  const headerRe = /^[A-Za-z0-9_.-]+\[\d+\]\{/;
  let currentName: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentName) {
      blocks[currentName] = decodeToonTable(buffer.join("\n"));
    }
  };
  for (const line of rest.split("\n")) {
    if (headerRe.test(line)) {
      flush();
      currentName = line.slice(0, line.indexOf("["));
      buffer = [line];
    } else if (currentName) {
      buffer.push(line);
    }
  }
  flush();
  return { legend, tree, blocks };
}

describe("encodeObserveCompact", () => {
  test("first line is the legend", () => {
    const { observe } = loadAndroidHomeObserve();
    const text = encodeObserveCompact(observe, "");
    expect(text.split("\n")[0]).toBe(OBSERVE_COMPACT_LEGEND);
  });

  test("second line is compact JSON with elements detached but viewHierarchy inline", () => {
    const { observe } = loadAndroidHomeObserve();
    const text = encodeObserveCompact(observe, "");
    const { tree } = parseCompact(text);
    expect(tree.elements).toBeUndefined();
    expect(tree.viewHierarchy).toBeDefined();
    // Compact JSON: no pretty-print newlines inside the tree line.
    expect(text.split("\n")[1].startsWith("{")).toBe(true);
  });

  test("emits a TOON block per element array with matching counts", () => {
    const { observe } = loadAndroidHomeObserve();
    const text = encodeObserveCompact(observe, "");
    const { blocks } = parseCompact(text);
    expect(blocks.clickable.rows.length).toBe(observe.elements!.clickable.length);
    expect(blocks.text.rows.length).toBe(observe.elements!.text.length);
    expect(blocks.media.rows.length).toBe(observe.elements!.media.length);
    expect(blocks.scrollable.rows.length).toBe(observe.elements!.scrollable.length);
  });

  test("flattens bounds to bounds.* columns and preserves values", () => {
    const observe: ObserveResult = {
      updatedAt: 1,
      screenSize: { width: 1080, height: 2400 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      elements: {
        clickable: [
          { bounds: { left: 10, top: 20, right: 30, bottom: 40 }, text: "Go" },
        ],
        scrollable: [],
        text: [],
        media: [],
      },
    } as unknown as ObserveResult;
    const { blocks } = parseCompact(encodeObserveCompact(observe, ""));
    const t = blocks.clickable;
    expect(t.columns).toContain("bounds.left");
    expect(t.columns).toContain("bounds.bottom");
    const row = Object.fromEntries(t.columns.map((c, i) => [c, t.rows[0][i]]));
    expect(row["bounds.left"]).toBe("10");
    expect(row["bounds.bottom"]).toBe("40");
    expect(row["text"]).toBe("Go");
  });

  test("nested node subtree is preserved as a JSON cell (lossless)", () => {
    const node = { "resource-id": "x", "bounds": { left: 1, top: 2, right: 3, bottom: 4 } };
    const observe: ObserveResult = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      elements: {
        clickable: [{ bounds: { left: 0, top: 0, right: 1, bottom: 1 }, node }],
        scrollable: [],
        text: [],
        media: [],
      },
    } as unknown as ObserveResult;
    const { blocks } = parseCompact(encodeObserveCompact(observe, ""));
    const t = blocks.clickable;
    const nodeCol = t.columns.indexOf("node");
    expect(nodeCol).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(t.rows[0][nodeCol]!)).toEqual(node);
  });

  test("accessibility `extras` are stripped inside nested node cells (matches the tree)", () => {
    const node = {
      "resource-id": "x",
      "extras": { "AccessibilityNodeInfo.roleDescription": "View" },
      "node": { text: "leaf", extras: { foo: "bar" } },
    };
    const observe: ObserveResult = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      elements: {
        clickable: [{ bounds: { left: 0, top: 0, right: 1, bottom: 1 }, node }],
        scrollable: [],
        text: [],
        media: [],
      },
    } as unknown as ObserveResult;
    const { blocks } = parseCompact(encodeObserveCompact(observe, ""));
    const t = blocks.clickable;
    const nodeCell = t.rows[0][t.columns.indexOf("node")]!;
    expect(nodeCell).not.toContain("extras");
    const parsed = JSON.parse(nodeCell);
    expect(parsed.extras).toBeUndefined();
    expect(parsed.node.extras).toBeUndefined();
    // Non-extras data survives.
    expect(parsed["resource-id"]).toBe("x");
    expect(parsed.node.text).toBe("leaf");
  });

  test("adversarial text with commas/quotes/newlines round-trips through the TOON cell", () => {
    const nasty = 'Buy 2, get "1" free\nnow';
    const observe: ObserveResult = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      elements: {
        clickable: [],
        scrollable: [],
        text: [{ bounds: { left: 0, top: 0, right: 1, bottom: 1 }, text: nasty }],
        media: [],
      },
    } as unknown as ObserveResult;
    const { blocks } = parseCompact(encodeObserveCompact(observe, ""));
    const t = blocks.text;
    const textCol = t.columns.indexOf("text");
    expect(t.rows[0][textCol]).toBe(nasty);
  });

  test("strips accessibility `extras` from element rows", () => {
    const observe: ObserveResult = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      elements: {
        clickable: [
          {
            bounds: { left: 0, top: 0, right: 1, bottom: 1 },
            text: "hi",
            extras: { "AccessibilityNodeInfo.roleDescription": "View" },
          },
        ],
        scrollable: [],
        text: [],
        media: [],
      },
    } as unknown as ObserveResult;
    const { blocks } = parseCompact(encodeObserveCompact(observe, ""));
    expect(blocks.clickable.columns).not.toContain("extras");
  });

  test("does not mutate the input ObserveResult", () => {
    const { observe } = loadAndroidHomeObserve();
    const before = JSON.stringify(observe);
    encodeObserveCompact(observe, "");
    expect(JSON.stringify(observe)).toBe(before);
  });

  test("wrapper path compacts the .observation elements and keeps sibling fields", () => {
    const { observe } = loadAndroidHomeObserve();
    const payload = { success: true, observation: observe } as unknown as Record<string, unknown>;
    const text = encodeObserveCompact(payload, "observation");
    const { tree, blocks } = parseCompact(text);
    expect(tree.success).toBe(true);
    expect((tree.observation as Record<string, unknown>).elements).toBeUndefined();
    expect((tree.observation as Record<string, unknown>).viewHierarchy).toBeDefined();
    expect(blocks.clickable.rows.length).toBe(observe.elements!.clickable.length);
  });

  test("compact text is smaller than the sanitized-pretty ship baseline on the #2755 fixture", () => {
    // Honest baseline: finalizeToolResponse ALWAYS sanitizes before encoding
    // (#2757), so the real comparison is compact vs sanitized-pretty, not raw
    // pretty. Sanitize does most of the reduction; compact/TOON is the marginal
    // win on top. Measuring against raw pretty would over-credit this change.
    const { observe } = loadAndroidHomeObserve();
    const sanitized = sanitizeObserveResult(observe, { dropElements: false });
    const sanitizedPrettyBytes = measureValue(sanitized).bytes;
    const compactBytes = Buffer.byteLength(
      encodeObserveCompact(sanitized as unknown as Record<string, unknown>, ""),
      "utf8"
    );
    expect(compactBytes).toBeLessThan(sanitizedPrettyBytes);
    // De-indent + TOON should still land well under the sanitized-pretty text.
    expect(compactBytes).toBeLessThan(sanitizedPrettyBytes * 0.6);
  });

  test("empty element arrays are omitted (no bare name[0]{}: noise)", () => {
    const observe: ObserveResult = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      elements: {
        clickable: [{ bounds: { left: 0, top: 0, right: 1, bottom: 1 }, text: "hi" }],
        scrollable: [],
        text: [],
        media: [],
      },
    } as unknown as ObserveResult;
    const text = encodeObserveCompact(observe, "");
    expect(text).toContain("clickable[");
    expect(text).not.toContain("scrollable[");
    expect(text).not.toContain("text[");
    expect(text).not.toContain("media[");
  });

  test("an empty-object element value is preserved as a {} cell, not dropped", () => {
    const observe: ObserveResult = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      elements: {
        clickable: [{ bounds: { left: 0, top: 0, right: 1, bottom: 1 }, meta: {} }],
        scrollable: [],
        text: [],
        media: [],
      },
    } as unknown as ObserveResult;
    const { blocks } = parseCompact(encodeObserveCompact(observe, ""));
    const t = blocks.clickable;
    const metaCol = t.columns.indexOf("meta");
    expect(metaCol).toBeGreaterThanOrEqual(0);
    expect(t.rows[0][metaCol]).toBe("{}");
  });

  test("compact text carries the same primitive top-level fields as pretty JSON", () => {
    const { observe } = loadAndroidHomeObserve();
    const { tree } = parseCompact(encodeObserveCompact(observe, ""));
    // Spot-check that non-elements data survives the compact encoding intact.
    expect(tree.updatedAt).toEqual(observe.updatedAt);
    expect(tree.rotation).toEqual(observe.rotation as unknown);
    expect(JSON.stringify(tree.screenSize)).toBe(JSON.stringify(observe.screenSize));
  });
});
