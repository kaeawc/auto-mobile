import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../src/models/ViewHierarchyResult";
import {
  sanitizeObserveResult,
  GFXINFO_DUMP_MARKER,
} from "../../../../src/features/observe/output/ObserveResultOutput";
import {
  loadAndroidHomeObserve,
  measureValue,
} from "../../../fixtures/observe/observeFixture";

/**
 * Unit tests for `sanitizeObserveResult` — the output-only transform for issue
 * #2757. Every reduction is measured against the frozen #2755 baseline fixture
 * (`android-home.json`) with the production formatter (`measureValue` ->
 * `stringifyToolResponse`), so a "does this actually shrink the wire payload?"
 * assertion is trustworthy rather than a compact-JSON undercount.
 *
 * The overarching contract: the function is PURE and OUTPUT-ONLY. It returns a
 * copy destined for the wire and never mutates the caller's in-memory
 * `ObserveResult` (internal consumers must be unaffected).
 */

/** Normalize a `node` slot (single or array, as real captures vary) to array. */
function toNodeArray(
  node: ViewHierarchyNode | ViewHierarchyNode[] | undefined
): ViewHierarchyNode[] {
  if (!node) {
    return [];
  }
  return Array.isArray(node) ? node : [node];
}

/** Deep structural walk collecting every hierarchy node (root + descendants). */
function collectNodes(node: ViewHierarchyNode | undefined): ViewHierarchyNode[] {
  if (!node) {
    return [];
  }
  const out: ViewHierarchyNode[] = [node];
  for (const child of toNodeArray(node.node)) {
    out.push(...collectNodes(child));
  }
  return out;
}

/** All hierarchy nodes reachable from an observe result's viewHierarchy. */
function allHierarchyNodes(obs: ObserveResult): ViewHierarchyNode[] {
  return toNodeArray(obs.viewHierarchy?.hierarchy?.node).flatMap(collectNodes);
}

const DROP_NONE = { dropElements: false } as const;
const DROP_ELEMENTS = { dropElements: true } as const;

describe("sanitizeObserveResult", () => {
  describe("purity / output-only contract", () => {
    test("does not mutate the input ObserveResult (deep-clone boundary)", () => {
      const { observe } = loadAndroidHomeObserve();
      const before = JSON.stringify(observe);

      sanitizeObserveResult(observe, DROP_ELEMENTS);

      expect(JSON.stringify(observe)).toBe(before);
    });

    test("returns a distinct object, not the same reference", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, DROP_NONE);
      expect(out).not.toBe(observe);
      expect(out.viewHierarchy).not.toBe(observe.viewHierarchy);
    });

    test("completes well under the 100ms unit-test budget", () => {
      const { observe } = loadAndroidHomeObserve();
      const start = performance.now();
      sanitizeObserveResult(observe, DROP_ELEMENTS);
      expect(performance.now() - start).toBeLessThan(100);
    });
  });

  describe("perf-audit strip (always)", () => {
    test("nulls gfxinfoRaw and cpuStatsRaw", () => {
      const { observe } = loadAndroidHomeObserve();
      // Precondition: the baseline carries the heavy raw dumps.
      expect(observe.performanceAudit?.metrics.gfxinfoRaw?.length).toBeGreaterThan(0);
      expect(observe.performanceAudit?.metrics.cpuStatsRaw?.length).toBeGreaterThan(0);

      const out = sanitizeObserveResult(observe, DROP_NONE);

      expect(out.performanceAudit?.metrics.gfxinfoRaw).toBeNull();
      expect(out.performanceAudit?.metrics.cpuStatsRaw).toBeNull();
    });

    test("truncates diagnostics to the summary above the GFXINFO DUMP marker", () => {
      const { observe } = loadAndroidHomeObserve();
      const original = observe.performanceAudit!.diagnostics!;
      expect(original).toContain(GFXINFO_DUMP_MARKER);
      const expectedSummary = original.slice(0, original.indexOf(GFXINFO_DUMP_MARKER)).trimEnd();

      const out = sanitizeObserveResult(observe, DROP_NONE);
      const diagnostics = out.performanceAudit!.diagnostics!;

      expect(diagnostics).not.toContain(GFXINFO_DUMP_MARKER);
      expect(diagnostics).toBe(expectedSummary);
      // The high-signal summary lines survive.
      expect(diagnostics).toContain("Performance issues detected:");
      expect(diagnostics).toContain("Top contributors:");
    });

    test("preserves computed metrics and violations", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, DROP_NONE);

      const m = out.performanceAudit!.metrics;
      const om = observe.performanceAudit!.metrics;
      expect(m.p50Ms).toBe(om.p50Ms);
      expect(m.p90Ms).toBe(om.p90Ms);
      expect(m.p95Ms).toBe(om.p95Ms);
      expect(m.p99Ms).toBe(om.p99Ms);
      expect(m.jankCount).toBe(om.jankCount);
      expect(m.cpuUsagePercent).toBe(om.cpuUsagePercent);
      expect(m.threadCount).toBe(om.threadCount);
      expect(m.touchLatencyMs).toBe(om.touchLatencyMs);
      expect(m.anrDetected).toBe(om.anrDetected);
      expect(out.performanceAudit!.violations).toEqual(observe.performanceAudit!.violations);
    });

    test("measurably shrinks the payload from the perf strip alone", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, DROP_NONE);
      // The raw dumps + inlined GFXINFO dominate the perf section (~17k bytes).
      expect(measureValue(out).bytes).toBeLessThan(measureValue(observe).bytes - 10_000);
    });

    test("is a no-op when performanceAudit is absent", () => {
      const { observe } = loadAndroidHomeObserve();
      delete observe.performanceAudit;
      const out = sanitizeObserveResult(observe, DROP_NONE);
      expect(out.performanceAudit).toBeUndefined();
    });
  });

  describe("per-node trim (default on)", () => {
    test("drops view-id when it equals resource-id", () => {
      const { observe } = loadAndroidHomeObserve();
      // Precondition: the baseline has nodes where view-id === resource-id.
      const dupBefore = allHierarchyNodes(observe).filter(
        n => n["view-id"] !== undefined && n["view-id"] === (n as Record<string, unknown>)["resource-id"]
      );
      expect(dupBefore.length).toBeGreaterThan(0);

      const out = sanitizeObserveResult(observe, DROP_NONE);

      for (const n of allHierarchyNodes(out)) {
        const rec = n as Record<string, unknown>;
        if (rec["resource-id"] !== undefined && n["view-id"] !== undefined) {
          expect(n["view-id"]).not.toBe(rec["resource-id"]);
        }
      }
    });

    test("keeps view-id when it differs from resource-id", () => {
      const obs: ObserveResult = {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: {
            node: {
              "view-id": "distinct-uuid",
              "node": [],
              "$": {},
            } as any,
          },
        },
      };
      (obs.viewHierarchy!.hierarchy!.node as unknown as Record<string, unknown>)["resource-id"] =
        "android:id/content";

      const out = sanitizeObserveResult(obs, DROP_NONE);
      expect(out.viewHierarchy!.hierarchy!.node!["view-id"]).toBe("distinct-uuid");
    });

    test("omits default-false booleans and empty-string fields (synthetic)", () => {
      const obs: ObserveResult = {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: {
            node: {
              "clickable": "false",
              "long-clickable": false,
              "focusable": "true",
              "text": "",
              "content-desc": "Keep me",
              "resource-id": "id/keep",
              "node": [],
              "$": {},
            } as any,
          },
        },
      };

      const out = sanitizeObserveResult(obs, DROP_NONE);
      const node = out.viewHierarchy!.hierarchy!.node as unknown as Record<string, unknown>;

      // Default-false booleans (string or boolean form) are dropped.
      expect(node).not.toHaveProperty("clickable");
      expect(node).not.toHaveProperty("long-clickable");
      // Empty-string fields are dropped.
      expect(node).not.toHaveProperty("text");
      // Meaningful values survive.
      expect(node.focusable).toBe("true");
      expect(node["content-desc"]).toBe("Keep me");
      expect(node["resource-id"]).toBe("id/keep");
    });

    test("measurably shrinks the payload from node trim", () => {
      const { observe } = loadAndroidHomeObserve();
      // Isolate node-trim: strip perf first so the delta is attributable to trim.
      const perfStripped = sanitizeObserveResult(observe, DROP_NONE);
      // Re-run with trim disabled to get a trim-off baseline of the same output.
      const trimOff = sanitizeObserveResult(observe, { dropElements: false, trimNodes: false });
      expect(measureValue(perfStripped).bytes).toBeLessThan(measureValue(trimOff).bytes);
    });

    test("does not touch rawViewHierarchy (raw stays raw)", () => {
      const { observe } = loadAndroidHomeObserve();
      observe.rawViewHierarchy = {
        hierarchy: {
          node: {
            "view-id": "android:id/content",
            "resource-id": "android:id/content",
            "clickable": "false",
            "text": "",
            "node": [],
            "$": {},
          },
        } as any,
      };
      const rawBefore = JSON.stringify(observe.rawViewHierarchy);

      const out = sanitizeObserveResult(observe, DROP_NONE);

      expect(JSON.stringify(out.rawViewHierarchy)).toBe(rawBefore);
    });

    test("can be disabled via trimNodes:false", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, { dropElements: false, trimNodes: false });
      const dup = allHierarchyNodes(out).filter(
        n => n["view-id"] !== undefined && n["view-id"] === (n as Record<string, unknown>)["resource-id"]
      );
      expect(dup.length).toBeGreaterThan(0);
    });
  });

  describe("elements-drop (gated)", () => {
    test("omits the elements block when dropElements is true", () => {
      const { observe } = loadAndroidHomeObserve();
      expect(observe.elements).toBeDefined();

      const out = sanitizeObserveResult(observe, DROP_ELEMENTS);
      expect(out.elements).toBeUndefined();
    });

    test("keeps the elements block when dropElements is false", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, DROP_NONE);
      expect(out.elements).toBeDefined();
    });

    test("measurably shrinks the payload when elements are dropped", () => {
      const { observe } = loadAndroidHomeObserve();
      const kept = sanitizeObserveResult(observe, DROP_NONE);
      const dropped = sanitizeObserveResult(observe, DROP_ELEMENTS);
      expect(measureValue(dropped).bytes).toBeLessThan(measureValue(kept).bytes);
    });
  });

  describe("combined reduction", () => {
    test("all three steps together substantially shrink the baseline", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, DROP_ELEMENTS);
      const before = measureValue(observe).bytes;
      const after = measureValue(out).bytes;
      // Perf strip (~17k) + elements drop + node trim take a large bite.
      expect(after).toBeLessThan(before * 0.7);
    });
  });
});
