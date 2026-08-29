import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../src/models/ViewHierarchyResult";
import {
  sanitizeObserveResult,
  GFXINFO_DUMP_MARKER,
  type SanitizeObserveConfig,
} from "../../../../src/features/observe/output/ObserveResultOutput";
import {
  loadAndroidHomeObserve,
  loadAndroidRawTrimCandidatesObserve,
  loadIosRemindersNoiseObservePair,
  measureValue,
} from "../../../fixtures/observe/observeFixture";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import scrollBeforeFixture from "../../../fixtures/observe/diff/scroll-before.json";

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
  node: ViewHierarchyNode | ViewHierarchyNode[] | undefined,
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
const COMPACT = { dropElements: false, compact: true } as const;
const DEFAULT_FALSE_BOOLEAN_KEYS = [
  "clickable",
  "long-clickable",
  "focusable",
  "focused",
  "scrollable",
  "checkable",
  "checked",
  "selected",
  "password",
] as const;

/** The documented positional order of a compacted bounds tuple. */
type BoundsTuple = [number, number, number, number];

/** True when `v` is a compacted bounds tuple `[left, top, right, bottom]`. */
function isBoundsTuple(v: unknown): v is BoundsTuple {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number");
}

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

    test("preserves an SDK-backed screen identity while compacting observation output", () => {
      const observe: ObserveResult = {
        updatedAt: 1,
        screenSize: { width: 100, height: 200 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        screenIdentity: {
          platform: "ios",
          source: "sdk",
          confidence: "high",
          key: '[["bundle","dev.jasonpearson.automobile.Playground"],["route","SettingsTab"]]',
          components: {
            bundleId: "dev.jasonpearson.automobile.Playground",
            navigationRoute: "SettingsTab",
          },
        },
      };

      expect(sanitizeObserveResult(observe, COMPACT).screenIdentity).toEqual(
        observe.screenIdentity,
      );
    });
  });

  describe("perf-audit strip (always)", () => {
    test("perf-audit strip nulls gfxinfoRaw and cpuStatsRaw", () => {
      const { observe } = loadAndroidHomeObserve();
      // Precondition: the baseline carries the heavy raw dumps.
      expect(observe.performanceAudit?.metrics.gfxinfoRaw?.length).toBeGreaterThan(0);
      expect(observe.performanceAudit?.metrics.cpuStatsRaw?.length).toBeGreaterThan(0);

      const out = sanitizeObserveResult(observe, DROP_NONE);

      expect(out.performanceAudit?.metrics.gfxinfoRaw).toBeNull();
      expect(out.performanceAudit?.metrics.cpuStatsRaw).toBeNull();
    });

    test("perf-audit strip truncates diagnostics to the summary above the GFXINFO DUMP marker", () => {
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

    test("perf-audit strip preserves computed metrics and violations", () => {
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

    test("perf-audit strip is a no-op when performanceAudit is absent", () => {
      const { observe } = loadAndroidHomeObserve();
      delete observe.performanceAudit;
      const out = sanitizeObserveResult(observe, DROP_NONE);
      expect(out.performanceAudit).toBeUndefined();
    });
  });

  describe("top-level debug-perf telemetry reduction (always)", () => {
    test("drops perfTiming from the output copy while leaving the input untouched", () => {
      const { observe } = loadAndroidHomeObserve();
      expect(observe.perfTiming).toBeDefined();
      const before = JSON.stringify(observe.perfTiming);

      const out = sanitizeObserveResult(observe, DROP_NONE);

      expect(out.perfTiming).toBeUndefined();
      expect(JSON.stringify(observe.perfTiming)).toBe(before);
    });

    test("measurably shrinks bytes and tokens by dropping fixture perfTiming", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, DROP_NONE);
      const withPerfTiming = { ...out, perfTiming: observe.perfTiming };

      expect(measureValue(out).bytes).toBeLessThan(measureValue(withPerfTiming).bytes);
      expect(measureValue(out).tokens).toBeLessThan(measureValue(withPerfTiming).tokens);
    });

    test("preserves action UI-stability gfxMetrics when no performanceAudit exists", () => {
      const { observe } = loadAndroidHomeObserve();
      delete observe.performanceAudit;
      observe.gfxMetrics = {
        packageName: "com.example.app",
        percentile50thMs: 12,
        percentile90thMs: 18,
        percentile95thMs: 22,
        percentile99thMs: 30,
        missedVsyncCount: 1,
        slowUiThreadCount: 1,
        frameDeadlineMissedCount: 0,
        pollCount: 7,
        stabilityWaitMs: 350,
        isStable: true,
      };
      const gfxMetricsBefore = JSON.stringify(observe.gfxMetrics);

      const out = sanitizeObserveResult(observe, DROP_NONE);

      expect(out.gfxMetrics).toEqual(observe.gfxMetrics);
      expect(JSON.stringify(observe.gfxMetrics)).toBe(gfxMetricsBefore);
    });

    test("trims redundant gfxMetrics frame fields when performanceAudit metrics are present", () => {
      const { observe } = loadAndroidHomeObserve();
      observe.gfxMetrics = {
        packageName: "com.example.app",
        percentile50thMs: 12,
        percentile90thMs: 18,
        percentile95thMs: 22,
        percentile99thMs: 30,
        missedVsyncCount: 1,
        slowUiThreadCount: 1,
        frameDeadlineMissedCount: 0,
        pollCount: 7,
        stabilityWaitMs: 350,
        isStable: true,
      };
      const auditMetricsBefore = JSON.stringify(observe.performanceAudit?.metrics);
      const gfxMetricsBefore = JSON.stringify(observe.gfxMetrics);

      const out = sanitizeObserveResult(observe, DROP_NONE);

      expect(out.gfxMetrics).toEqual({
        packageName: "com.example.app",
        pollCount: 7,
        stabilityWaitMs: 350,
        isStable: true,
      });
      expect(JSON.stringify(observe.gfxMetrics)).toBe(gfxMetricsBefore);
      expect(JSON.stringify(observe.performanceAudit?.metrics)).toBe(auditMetricsBefore);
    });

    test("preserves gfxMetrics frame fields when audit replacements are null", () => {
      const { observe } = loadAndroidHomeObserve();
      observe.performanceAudit!.metrics.p50Ms = null;
      observe.performanceAudit!.metrics.p90Ms = null;
      observe.performanceAudit!.metrics.p95Ms = null;
      observe.performanceAudit!.metrics.p99Ms = null;
      observe.performanceAudit!.metrics.missedVsyncCount = null;
      observe.performanceAudit!.metrics.slowUiThreadCount = null;
      observe.performanceAudit!.metrics.frameDeadlineMissedCount = null;
      observe.gfxMetrics = {
        packageName: "com.example.app",
        percentile50thMs: 12,
        percentile90thMs: 18,
        percentile95thMs: 22,
        percentile99thMs: 30,
        missedVsyncCount: 1,
        slowUiThreadCount: 1,
        frameDeadlineMissedCount: 0,
        pollCount: 7,
        stabilityWaitMs: 350,
        isStable: true,
      };

      const out = sanitizeObserveResult(observe, DROP_NONE);

      expect(out.gfxMetrics).toEqual(observe.gfxMetrics);
    });

    test("measurably shrinks bytes and tokens by trimming redundant gfxMetrics frame fields", () => {
      const { observe } = loadAndroidHomeObserve();
      observe.gfxMetrics = {
        packageName: "com.example.app",
        percentile50thMs: 12,
        percentile90thMs: 18,
        percentile95thMs: 22,
        percentile99thMs: 30,
        missedVsyncCount: 1,
        slowUiThreadCount: 1,
        frameDeadlineMissedCount: 0,
        pollCount: 7,
        stabilityWaitMs: 350,
        isStable: true,
      };

      const out = sanitizeObserveResult(observe, DROP_NONE);
      const withFullGfxMetrics = { ...out, gfxMetrics: observe.gfxMetrics };

      expect(measureValue(out).bytes).toBeLessThan(measureValue(withFullGfxMetrics).bytes);
      expect(measureValue(out).tokens).toBeLessThan(measureValue(withFullGfxMetrics).tokens);
    });

    test("preserves the perfTimingTruncated signal", () => {
      const { observe } = loadAndroidHomeObserve();
      observe.perfTimingTruncated = true;

      const out = sanitizeObserveResult(observe, DROP_NONE);

      expect(out.perfTiming).toBeUndefined();
      expect(out.perfTimingTruncated).toBe(true);
    });
  });

  describe("per-node trim (default on)", () => {
    test("drops view-id when it equals resource-id", () => {
      const { observe } = loadAndroidHomeObserve();
      // Precondition: the baseline has nodes where view-id === resource-id.
      const dupBefore = allHierarchyNodes(observe).filter(
        (n) =>
          n["view-id"] !== undefined &&
          n["view-id"] === (n as Record<string, unknown>)["resource-id"],
      );
      expect(dupBefore.length).toBeGreaterThan(0);

      // Count-guard (R2): the fixture carries view-ids that DIFFER from
      // resource-id and must survive the dedup. Without this, a trim that
      // deleted EVERY view-id would pass the loop below vacuously.
      const distinctBefore = allHierarchyNodes(observe).filter(
        (n) =>
          n["view-id"] !== undefined &&
          n["view-id"] !== (n as Record<string, unknown>)["resource-id"],
      );
      expect(distinctBefore.length).toBeGreaterThan(0);

      const out = sanitizeObserveResult(observe, DROP_NONE);

      const survivingViewIds = allHierarchyNodes(out).filter((n) => n["view-id"] !== undefined);
      // The distinct view-ids are not collateral damage of the dedup.
      expect(survivingViewIds.length).toBeGreaterThan(0);
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
              node: [],
              $: {},
            } as any,
          },
        },
      };
      (obs.viewHierarchy!.hierarchy!.node as unknown as Record<string, unknown>)["resource-id"] =
        "android:id/content";

      const out = sanitizeObserveResult(obs, DROP_NONE);
      expect(out.viewHierarchy!.hierarchy!.node!["view-id"]).toBe("distinct-uuid");
    });

    test("preserves duplicate view-id when referenced by occludedByViewId", () => {
      const obs: ObserveResult = {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: {
            node: [
              {
                "resource-id": "id/covered",
                "view-id": "id/covered",
                occludedByViewId: "id/overlay",
                node: [],
                $: {},
              },
              {
                "resource-id": "id/overlay",
                "view-id": "id/overlay",
                node: [],
                $: {},
              },
              {
                "resource-id": "id/unreferenced",
                "view-id": "id/unreferenced",
                node: [],
                $: {},
              },
            ] as any,
          },
        },
      };

      const out = sanitizeObserveResult(obs, DROP_NONE);
      const [covered, overlay, unreferenced] = out.viewHierarchy!.hierarchy!
        .node as unknown as Array<Record<string, unknown>>;

      expect(covered.occludedByViewId).toBe("id/overlay");
      expect(covered["view-id"]).toBeUndefined();
      expect(overlay["view-id"]).toBe("id/overlay");
      expect(unreferenced["view-id"]).toBeUndefined();
    });

    test("omits default-false booleans and empty-string fields (synthetic)", () => {
      const obs: ObserveResult = {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: {
            node: {
              clickable: "false",
              "long-clickable": false,
              focusable: "true",
              text: "",
              "content-desc": "Keep me",
              "resource-id": "id/keep",
              node: [],
              $: {},
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

    test("drops enabled when true but preserves enabled=false (default-true convention)", () => {
      const makeObs = (enabled: string): ObserveResult => ({
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: {
            node: {
              enabled: enabled,
              "resource-id": "id/keep",
              node: [],
              $: {},
            } as any,
          },
        },
      });

      const enabledTrue = sanitizeObserveResult(makeObs("true"), DROP_NONE);
      const enabledFalse = sanitizeObserveResult(makeObs("false"), DROP_NONE);
      const trueNode = enabledTrue.viewHierarchy!.hierarchy!.node as unknown as Record<
        string,
        unknown
      >;
      const falseNode = enabledFalse.viewHierarchy!.hierarchy!.node as unknown as Record<
        string,
        unknown
      >;

      // enabled defaults to true → absence is lossless; a disabled control is high-signal.
      expect(trueNode).not.toHaveProperty("enabled");
      expect(falseNode.enabled).toBe("false");
    });

    test("measurably shrinks the payload from node trim (view-id dedup, real fixture)", () => {
      const { observe } = loadAndroidHomeObserve();
      // Isolate node-trim: strip perf first so the delta is attributable to trim.
      const perfStripped = sanitizeObserveResult(observe, DROP_NONE);
      // Re-run with trim disabled to get a trim-off baseline of the same output.
      const trimOff = sanitizeObserveResult(observe, { dropElements: false, trimNodes: false });
      expect(measureValue(perfStripped).bytes).toBeLessThan(measureValue(trimOff).bytes);
    });

    test("measurably shrinks false booleans over a real raw hierarchy capture", () => {
      const obs = loadAndroidRawTrimCandidatesObserve();
      for (const node of allHierarchyNodes(obs)) {
        const attrs = node as unknown as Record<string, unknown>;
        delete attrs.enabled;
        for (const [key, value] of Object.entries(attrs)) {
          if (value === "") {
            delete attrs[key];
          }
        }
      }
      const falseBooleanCandidates = allHierarchyNodes(obs).filter((node) => {
        const attrs = node as unknown as Record<string, unknown>;
        return DEFAULT_FALSE_BOOLEAN_KEYS.some((key) => attrs[key] === "false");
      });
      expect(falseBooleanCandidates.length).toBeGreaterThan(0);

      const trimmed = sanitizeObserveResult(obs, { dropElements: false, trimNodes: true });
      const untrimmed = sanitizeObserveResult(obs, { dropElements: false, trimNodes: false });
      expect(measureValue(trimmed).bytes).toBeLessThan(measureValue(untrimmed).bytes);
      expect(measureValue(trimmed).tokens).toBeLessThan(measureValue(untrimmed).tokens);
    });

    test("measurably shrinks empty-string fields over a real raw hierarchy capture", () => {
      const obs = loadAndroidRawTrimCandidatesObserve();
      for (const node of allHierarchyNodes(obs)) {
        const attrs = node as unknown as Record<string, unknown>;
        delete attrs.enabled;
        for (const key of DEFAULT_FALSE_BOOLEAN_KEYS) {
          delete attrs[key];
        }
      }
      const emptyStringCandidates = allHierarchyNodes(obs).filter((node) =>
        Object.values(node as unknown as Record<string, unknown>).some((value) => value === ""),
      );
      expect(emptyStringCandidates.length).toBeGreaterThan(0);

      const trimmed = sanitizeObserveResult(obs, { dropElements: false, trimNodes: true });
      const untrimmed = sanitizeObserveResult(obs, { dropElements: false, trimNodes: false });
      expect(measureValue(trimmed).bytes).toBeLessThan(measureValue(untrimmed).bytes);
      expect(measureValue(trimmed).tokens).toBeLessThan(measureValue(untrimmed).tokens);
    });

    test("measurably shrinks enabled=true over a real raw hierarchy capture", () => {
      const obs = loadAndroidRawTrimCandidatesObserve();
      for (const node of allHierarchyNodes(obs)) {
        const attrs = node as unknown as Record<string, unknown>;
        for (const key of DEFAULT_FALSE_BOOLEAN_KEYS) {
          delete attrs[key];
        }
        for (const [key, value] of Object.entries(attrs)) {
          if (value === "") {
            delete attrs[key];
          }
        }
      }
      const enabledTrueCandidates = allHierarchyNodes(obs).filter(
        (node) => (node as unknown as Record<string, unknown>).enabled === "true",
      );
      expect(enabledTrueCandidates.length).toBeGreaterThan(0);

      const trimmed = sanitizeObserveResult(obs, { dropElements: false, trimNodes: true });
      const untrimmed = sanitizeObserveResult(obs, { dropElements: false, trimNodes: false });
      expect(measureValue(trimmed).bytes).toBeLessThan(measureValue(untrimmed).bytes);
      expect(measureValue(trimmed).tokens).toBeLessThan(measureValue(untrimmed).tokens);
    });

    test("per-node trim does not touch rawViewHierarchy (raw stays raw)", () => {
      const { observe } = loadAndroidHomeObserve();
      observe.rawViewHierarchy = {
        hierarchy: {
          node: {
            "view-id": "android:id/content",
            "resource-id": "android:id/content",
            clickable: "false",
            text: "",
            node: [],
            $: {},
          },
        } as any,
      };
      const rawBefore = JSON.stringify(observe.rawViewHierarchy);

      const out = sanitizeObserveResult(observe, DROP_NONE);

      expect(JSON.stringify(out.rawViewHierarchy)).toBe(rawBefore);
    });

    test("per-node trim can be disabled via trimNodes:false", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, { dropElements: false, trimNodes: false });
      const dup = allHierarchyNodes(out).filter(
        (n) =>
          n["view-id"] !== undefined &&
          n["view-id"] === (n as Record<string, unknown>)["resource-id"],
      );
      expect(dup.length).toBeGreaterThan(0);
    });
  });

  describe("elements-drop (gated)", () => {
    test("elements-drop omits the elements block when dropElements is true", () => {
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

  describe("compact bounds flatten (gated)", () => {
    test("flattens every node's bounds object to a [left,top,right,bottom] tuple when compact is on", () => {
      const { observe } = loadAndroidHomeObserve();
      // Precondition: the baseline carries object-shaped bounds on nodes.
      const withBoundsBefore = allHierarchyNodes(observe).filter((n) => n.bounds !== undefined);
      expect(withBoundsBefore.length).toBeGreaterThan(0);
      expect(withBoundsBefore.every((n) => !Array.isArray(n.bounds))).toBe(true);

      const out = sanitizeObserveResult(observe, COMPACT);

      const withBoundsAfter = allHierarchyNodes(out).filter((n) => n.bounds !== undefined);
      expect(withBoundsAfter.length).toBe(withBoundsBefore.length);
      for (const n of withBoundsAfter) {
        expect(isBoundsTuple(n.bounds)).toBe(true);
      }
    });

    test("keeps object-shaped bounds when compact is off (today's shape)", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, DROP_NONE);
      let checked = 0;
      for (const n of allHierarchyNodes(out)) {
        if (n.bounds !== undefined) {
          expect(Array.isArray(n.bounds)).toBe(false);
          expect(n.bounds).toHaveProperty("left");
          checked++;
        }
      }
      // Count-guard (R4): a trim that dropped every `bounds` would pass the loop
      // vacuously — mirrors the `checked > 0` idiom in the round-trip test below.
      expect(checked).toBeGreaterThan(0);
    });

    test("bounds tuple round-trips losslessly back to the original object", () => {
      const { observe } = loadAndroidHomeObserve();
      const originalByViewId = new Map<string, unknown>();
      for (const n of allHierarchyNodes(observe)) {
        const id = (n as Record<string, unknown>)["view-id"];
        if (typeof id === "string" && n.bounds) {
          originalByViewId.set(id, n.bounds);
        }
      }

      const out = sanitizeObserveResult(observe, COMPACT);
      let checked = 0;
      for (const n of allHierarchyNodes(out)) {
        const id = (n as Record<string, unknown>)["view-id"];
        if (typeof id === "string" && isBoundsTuple(n.bounds)) {
          const orig = originalByViewId.get(id) as {
            left: number;
            top: number;
            right: number;
            bottom: number;
          };
          expect(orig).toBeDefined();
          const [left, top, right, bottom] = n.bounds;
          expect({ left, top, right, bottom }).toEqual(orig);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    test("does not mutate the input ObserveResult (bounds stays an object on the original)", () => {
      const { observe } = loadAndroidHomeObserve();
      const before = JSON.stringify(observe);
      sanitizeObserveResult(observe, COMPACT);
      expect(JSON.stringify(observe)).toBe(before);
    });

    test("measurably shrinks bytes and tokens versus the non-compact output", () => {
      const { observe } = loadAndroidHomeObserve();
      const nonCompact = sanitizeObserveResult(observe, DROP_NONE);
      const compact = sanitizeObserveResult(observe, COMPACT);
      expect(measureValue(compact).bytes).toBeLessThan(measureValue(nonCompact).bytes);
      expect(measureValue(compact).tokens).toBeLessThan(measureValue(nonCompact).tokens);
    });

    test("bounds compaction is a no-op for nodes that carry no bounds", () => {
      const obs: ObserveResult = {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: {
            node: { "resource-id": "id/no-bounds", node: [], $: {} } as any,
          },
        },
      };
      const out = sanitizeObserveResult(obs, COMPACT);
      const node = out.viewHierarchy!.hierarchy!.node as unknown as Record<string, unknown>;
      expect(node.bounds).toBeUndefined();
    });

    test("compacts bounds on an array-shaped root and nested children", () => {
      const obs: ObserveResult = {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: {
            node: [
              {
                "resource-id": "a",
                bounds: { left: 1, top: 2, right: 3, bottom: 4 },
                node: [
                  { "resource-id": "a-child", bounds: { left: 5, top: 6, right: 7, bottom: 8 } },
                ],
              },
              { "resource-id": "b", bounds: { left: 9, top: 10, right: 11, bottom: 12 } },
            ] as any,
          },
        },
      };
      const out = sanitizeObserveResult(obs, COMPACT);
      const roots = out.viewHierarchy!.hierarchy!.node as unknown as Array<Record<string, unknown>>;
      expect(roots[0].bounds).toEqual([1, 2, 3, 4]);
      expect((roots[0].node as Array<Record<string, unknown>>)[0].bounds).toEqual([5, 6, 7, 8]);
      expect(roots[1].bounds).toEqual([9, 10, 11, 12]);
    });

    test("composes with trimNodes and dropElements (tuple bounds + trimmed attrs + no elements)", () => {
      const obs: ObserveResult = {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: {
            node: {
              "resource-id": "id/root",
              "view-id": "id/root", // dup → trimmed
              clickable: "false", // default-false → trimmed
              text: "", // empty → trimmed
              bounds: { left: 0, top: 0, right: 100, bottom: 200 },
              node: [],
              $: {},
            } as any,
          },
        },
        elements: { clickable: [], scrollable: [], text: [], media: [] },
      };
      const out = sanitizeObserveResult(obs, {
        dropElements: true,
        trimNodes: true,
        compact: true,
      });
      const node = out.viewHierarchy!.hierarchy!.node as unknown as Record<string, unknown>;
      expect(node.bounds).toEqual([0, 0, 100, 200]);
      expect(node["view-id"]).toBeUndefined();
      expect(node.clickable).toBeUndefined();
      expect(node.text).toBeUndefined();
      expect(out.elements).toBeUndefined();
    });
  });

  describe("iOS XCTest/UIKit cleanup fixture (#3317)", () => {
    // R5: the old "before smaller than after" test compared two DIFFERENT
    // fixtures, so it measured the fixtures' hand-authored size gap, not any
    // behavior of `sanitizeObserveResult`. Rewritten to a single fixture:
    // COMPACT must shrink that one observation versus its own non-compact output.
    // D1/D2 removed the two fixture-only assertions that called no src symbol
    // (they inspected `loadIosRemindersNoiseObservePair().after` directly).
    test("compacting a single iOS Reminders observation shrinks its own output", () => {
      const { before } = loadIosRemindersNoiseObservePair();

      const nonCompact = sanitizeObserveResult(before, DROP_NONE);
      const compact = sanitizeObserveResult(before, COMPACT);

      expect(measureValue(compact).bytes).toBeLessThan(measureValue(nonCompact).bytes);
      expect(measureValue(compact).tokens).toBeLessThan(measureValue(nonCompact).tokens);
    });
  });

  describe("compact flattens EVERY bounds site, not just nodes (#2978)", () => {
    /** Observe result seeded with a bounds object at every distinct site. */
    function makeMultiSiteObserve(): ObserveResult {
      return {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 5, bottom: 6, left: 7, right: 8 },
        focusedElement: { bounds: { left: 1, top: 2, right: 3, bottom: 4 } } as any,
        accessibilityFocusedElement: { bounds: { left: 9, top: 10, right: 11, bottom: 12 } } as any,
        awaitedElement: { bounds: { left: 13, top: 14, right: 15, bottom: 16 } } as any,
        elements: {
          clickable: [{ bounds: { left: 20, top: 21, right: 22, bottom: 23 }, text: "btn" } as any],
          scrollable: [{ bounds: { left: 30, top: 31, right: 32, bottom: 33 } } as any],
          text: [{ bounds: { left: 40, top: 41, right: 42, bottom: 43 } } as any],
          media: [{ bounds: { left: 50, top: 51, right: 52, bottom: 53 } } as any],
        },
        viewHierarchy: {
          systemInsets: { top: 1, bottom: 2, left: 3, right: 4 },
          hierarchy: {
            bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } as any,
            node: {
              "resource-id": "root",
              bounds: { left: 60, top: 61, right: 62, bottom: 63 },
            } as any,
          },
          windows: [{ bounds: { left: 70, top: 71, right: 72, bottom: 73 } } as any],
          contentHiddenRegions: [
            { bounds: { left: 80, top: 81, right: 82, bottom: 83 }, reason: "x", areaPercent: 1 },
          ],
        },
      } as ObserveResult;
    }

    test("flattens elements[].bounds across all four element buckets", () => {
      const out = sanitizeObserveResult(makeMultiSiteObserve(), COMPACT);
      const e = out.elements!;
      expect((e.clickable[0] as any).bounds).toEqual([20, 21, 22, 23]);
      expect((e.scrollable[0] as any).bounds).toEqual([30, 31, 32, 33]);
      expect((e.text[0] as any).bounds).toEqual([40, 41, 42, 43]);
      expect((e.media[0] as any).bounds).toEqual([50, 51, 52, 53]);
    });

    test("flattens the Hierarchy root, window, and content-hidden-region bounds", () => {
      const out = sanitizeObserveResult(makeMultiSiteObserve(), COMPACT);
      const vh = out.viewHierarchy!;
      expect((vh.hierarchy as any).bounds).toEqual([0, 0, 1080, 2400]);
      expect((vh.windows![0] as any).bounds).toEqual([70, 71, 72, 73]);
      expect((vh.contentHiddenRegions![0] as any).bounds).toEqual([80, 81, 82, 83]);
    });

    test("flattens focused / accessibility-focused / awaited element bounds", () => {
      const out = sanitizeObserveResult(makeMultiSiteObserve(), COMPACT);
      expect((out.focusedElement as any).bounds).toEqual([1, 2, 3, 4]);
      expect((out.accessibilityFocusedElement as any).bounds).toEqual([9, 10, 11, 12]);
      expect((out.awaitedElement as any).bounds).toEqual([13, 14, 15, 16]);
    });

    test("NEVER compacts systemInsets (a {top,bottom,left,right} object, not bounds)", () => {
      const out = sanitizeObserveResult(makeMultiSiteObserve(), COMPACT);
      // Top-level and viewHierarchy insets stay object-shaped and untouched.
      expect(out.systemInsets).toEqual({ top: 5, bottom: 6, left: 7, right: 8 });
      expect(out.viewHierarchy!.systemInsets).toEqual({ top: 1, bottom: 2, left: 3, right: 4 });
    });

    test("leaves rawViewHierarchy untouched (raw stays raw)", () => {
      const obs = makeMultiSiteObserve();
      obs.rawViewHierarchy = {
        hierarchy: {
          node: { "resource-id": "raw", bounds: { left: 90, top: 91, right: 92, bottom: 93 } },
        },
      } as any;
      const rawBefore = JSON.stringify(obs.rawViewHierarchy);

      const out = sanitizeObserveResult(obs, COMPACT);

      expect(JSON.stringify(out.rawViewHierarchy)).toBe(rawBefore);
      // ...while the processed hierarchy WAS compacted (proves the skip is targeted).
      expect((out.viewHierarchy!.hierarchy.node as any).bounds).toEqual([60, 61, 62, 63]);
    });

    test("is output-only across every site (input object never mutated)", () => {
      const obs = makeMultiSiteObserve();
      const before = JSON.stringify(obs);
      sanitizeObserveResult(obs, COMPACT);
      expect(JSON.stringify(obs)).toBe(before);
    });

    // P2 — purity table. Every sanitize configuration is OUTPUT-ONLY: it deep-
    // clones and mutates only the copy, so no config may perturb the caller's
    // in-memory ObserveResult. Placed in this block so `makeMultiSiteObserve`
    // (which seeds a bounds object at every distinct site) is in scope. One row
    // per transform toggle; a new transform added without a purity row is the
    // regression this table exists to catch.
    const PURITY_CONFIGS: ReadonlyArray<readonly [string, SanitizeObserveConfig]> = [
      ["elements-drop", { dropElements: true }],
      ["compact bounds", { dropElements: false, compact: true }],
      ["node trim", { dropElements: false, trimNodes: true }],
      ["skeleton projection", { dropElements: false, project: "skeleton" }],
      ["compact + drop + trim composed", { dropElements: true, compact: true, trimNodes: true }],
      ["all transforms off (trim disabled)", { dropElements: false, trimNodes: false }],
    ];

    test.each(PURITY_CONFIGS)("sanitize is output-only under %s", (_label, cfg) => {
      const input = makeMultiSiteObserve();
      const before = JSON.stringify(input);
      const out = sanitizeObserveResult(input, cfg);
      // The caller's object is byte-for-byte unchanged...
      expect(JSON.stringify(input)).toBe(before);
      // ...and the returned copy is a distinct reference.
      expect(out).not.toBe(input);
    });
  });

  describe("skeleton projection (cfg.project)", () => {
    test("project 'skeleton' replaces viewHierarchy + elements with a skeleton", () => {
      const { observe } = loadAndroidHomeObserve();
      // Precondition: the baseline carries a real hierarchy and elements block.
      expect(observe.viewHierarchy?.hierarchy).toBeDefined();
      expect(observe.elements).toBeDefined();

      const out = sanitizeObserveResult(observe, { dropElements: false, project: "skeleton" });

      expect(out.skeleton).toBeDefined();
      expect(Array.isArray(out.skeleton)).toBe(true);
      expect(out.skeleton!.length).toBeGreaterThan(0);
      expect(out.viewHierarchy).toBeUndefined();
      expect(out.elements).toBeUndefined();
    });

    test("skeleton entries carry tuple bounds regardless of the compact flag", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, { dropElements: false, project: "skeleton" });
      for (const entry of out.skeleton!) {
        expect(Array.isArray(entry.bounds)).toBe(true);
        expect(entry.bounds).toHaveLength(4);
      }
    });

    test("project 'full' (default) leaves the hierarchy in place — no skeleton", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, { dropElements: false, project: "full" });
      expect(out.skeleton).toBeUndefined();
      expect(out.viewHierarchy?.hierarchy).toBeDefined();
    });

    test("absent project behaves as 'full' (default behavior unchanged)", () => {
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, DROP_NONE);
      expect(out.skeleton).toBeUndefined();
      expect(out.viewHierarchy?.hierarchy).toBeDefined();
    });

    test("is output-only: the input observe result is never mutated", () => {
      const { observe } = loadAndroidHomeObserve();
      const before = JSON.stringify(observe);
      sanitizeObserveResult(observe, { dropElements: false, project: "skeleton" });
      expect(JSON.stringify(observe)).toBe(before);
    });

    test("hoists the exact-fill descendant through the JSON-clone boundary (#5881)", () => {
      // The collector tags each element with non-enumerable Symbol ancestry
      // provenance (#5881). `sanitizeObserveResult` JSON-clones its input before
      // projecting, which strips that Symbol — so the projection must read the
      // pre-clone elements. This drives the real collector on the checked-in
      // `long_press_card` fixture (an exact-fill content-desc descendant) through
      // the full sanitize path: if provenance is lost, the exact-fill child is
      // dropped and the card comes back label:"Long press me" (geometry fallback).
      const observe: ObserveResult = {
        ...(scrollBeforeFixture as unknown as ObserveResult),
        elements: new DefaultObserveElementCollector().collect(
          scrollBeforeFixture.viewHierarchy as NonNullable<ObserveResult["viewHierarchy"]>,
          "android",
        ),
      };

      const out = sanitizeObserveResult(observe, { dropElements: true, project: "skeleton" });

      const card = out.skeleton?.find((entry) => entry.id === "long_press_card");
      expect(card).toBeDefined();
      expect(card?.label).toBe("Basic long press card");
      expect(card?.sublabel).toContain("Long press me");
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

    test("also reduces the token count — the metric the MCP output cap enforces", () => {
      // Tokens (not bytes) are what the tool-output cap is measured in, so the
      // reduction must hold on tokens as well. See observeFixture.ts / #2755.
      const { observe } = loadAndroidHomeObserve();
      const out = sanitizeObserveResult(observe, DROP_ELEMENTS);
      const before = measureValue(observe).tokens;
      const after = measureValue(out).tokens;
      expect(after).toBeLessThan(before * 0.7);
    });
  });

  // ---- P3: default-false boolean drop table -----------------------------
  //
  // The trim drops a view-hierarchy boolean only when it holds its documented
  // default value (`false` / `"false"`) AND the key is on the allow-list. The
  // allow-list's whole rationale — "do not nuke a legit text field that happens
  // to hold the string 'false'" — was previously untested. This table exercises
  // every allow-listed key in both its string and boolean form (dropped), the
  // non-default forms (kept), and the survivor rows the allow-list protects.
  describe("default-false boolean drop table (P3)", () => {
    /** Trim one synthetic node carrying `attrs` and return the surviving attrs. */
    function trimmedNode(attrs: Record<string, unknown>): Record<string, unknown> {
      const obs: ObserveResult = {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: {
            node: { class: "android.view.View", ...attrs, node: [], $: {} } as any,
          },
        },
      };
      return sanitizeObserveResult(obs, DROP_NONE).viewHierarchy!.hierarchy!
        .node as unknown as Record<string, unknown>;
    }

    test.each(DEFAULT_FALSE_BOOLEAN_KEYS)("%s='false' (string default) is dropped", (key) => {
      expect(trimmedNode({ [key]: "false" })).not.toHaveProperty(key);
    });

    test.each(DEFAULT_FALSE_BOOLEAN_KEYS)("%s=false (boolean default) is dropped", (key) => {
      expect(trimmedNode({ [key]: false })).not.toHaveProperty(key);
    });

    test.each(DEFAULT_FALSE_BOOLEAN_KEYS)("%s='true' (non-default) is kept", (key) => {
      expect(trimmedNode({ [key]: "true" })[key]).toBe("true");
    });

    test.each(DEFAULT_FALSE_BOOLEAN_KEYS)("%s=true (boolean non-default) is kept", (key) => {
      expect(trimmedNode({ [key]: true })[key]).toBe(true);
    });

    // Survivor rows: a value of "false" on a NON-allow-listed key, or on a text
    // field, is real content and must never be dropped. The whitespace rows pin
    // that emptiness is literal `""`, not "blank after trimming": a single space
    // and a zero-width space are both content the trim keeps.
    const SURVIVORS: ReadonlyArray<readonly [string, string, unknown]> = [
      ["text holding the literal 'false'", "text", "false"],
      ["content-desc holding 'false'", "content-desc", "false"],
      ["resource-id holding 'false'", "resource-id", "false"],
      ["a non-allow-listed flag holding 'false'", "custom-flag", "false"],
      ["text holding '0'", "text", "0"],
      ["text of a single space (not empty)", "text", " "],
      ["content-desc of a single space (not empty)", "content-desc", " "],
      // JS `.trim()` does NOT strip U+200B, so this survives even a trim-based
      // empty check — it documents current behavior rather than guarding it.
      ["text of a zero-width space U+200B (not empty)", "text", "​"],
    ];

    test.each(SURVIVORS)("%s survives the trim", (_label, key, value) => {
      expect(trimmedNode({ [key]: value })[key]).toBe(value);
    });
  });

  // ---- A3 / P4: bounds-compaction shape table ---------------------------
  //
  // Compaction flattens a `{left,top,right,bottom}` object to the positional
  // tuple `[left,top,right,bottom]`. The positional contract means a hole must
  // stay a hole (an `undefined` slot), NEVER be dropped — dropping it would shift
  // every following coordinate and silently corrupt the decode. Non-object bounds
  // (already a tuple, or a string) are left untouched so the transform is
  // idempotent.
  describe("bounds-compaction shape table (A3/P4)", () => {
    /** Compact a single node whose `bounds` is `input`; return the emitted bounds. */
    function compactNodeBounds(input: unknown): unknown {
      const obs: ObserveResult = {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: {
            node: { "resource-id": "r", bounds: input as any, node: [], $: {} } as any,
          },
        },
      };
      return (sanitizeObserveResult(obs, COMPACT).viewHierarchy!.hierarchy!.node as any).bounds;
    }

    const ROWS: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["full object", { left: 1, top: 2, right: 3, bottom: 4 }, [1, 2, 3, 4]],
      ["zero values", { left: 0, top: 0, right: 0, bottom: 0 }, [0, 0, 0, 0]],
      ["negative values", { left: -5, top: -10, right: 5, bottom: 10 }, [-5, -10, 5, 10]],
      [
        "fractional values",
        { left: 1.5, top: 2.25, right: 3.75, bottom: 4.5 },
        [1.5, 2.25, 3.75, 4.5],
      ],
      // Partial holes: the ONLY rows that catch a hole-dropping compactor. Holes
      // are `undefined` in-memory (they only serialize to `null` via JSON).
      [
        "missing left+top (leading holes)",
        { right: 30, bottom: 40 },
        [undefined, undefined, 30, 40],
      ],
      [
        "missing right+bottom (trailing holes)",
        { left: 10, top: 20 },
        [10, 20, undefined, undefined],
      ],
      [
        "null-valued left (kept as null, not dropped)",
        { left: null, top: 0, right: 10, bottom: 10 },
        [null, 0, 10, 10],
      ],
      ["large values", { left: 0, top: 0, right: 100000, bottom: 250000 }, [0, 0, 100000, 250000]],
      // Non-object bounds are left untouched → idempotent.
      ["already a tuple (idempotent)", [1, 2, 3, 4], [1, 2, 3, 4]],
      ["a string bounds (untouched)", "0,0,10,10", "0,0,10,10"],
    ];

    test.each(ROWS)("%s compacts to the expected tuple", (_label, input, expected) => {
      expect(compactNodeBounds(input)).toEqual(expected);
    });

    test("double compaction never nests the tuple ([[...]])", () => {
      const once = compactNodeBounds({ left: 1, top: 2, right: 3, bottom: 4 });
      expect(compactNodeBounds(once)).toEqual([1, 2, 3, 4]);
    });

    test("a node with no bounds stays without bounds (no synthetic tuple)", () => {
      expect(compactNodeBounds(undefined)).toBeUndefined();
    });

    // D6: the old diff "tuple-vs-tuple" characterization is folded here — the
    // shape contract lives with the compactor, not the diff.
    test("systemInsets (a {top,bottom,left,right} object) is never compacted", () => {
      const obs: ObserveResult = {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 5, bottom: 6, left: 7, right: 8 },
        viewHierarchy: { hierarchy: { node: { "resource-id": "r" } as any } },
      };
      expect(sanitizeObserveResult(obs, COMPACT).systemInsets).toEqual({
        top: 5,
        bottom: 6,
        left: 7,
        right: 8,
      });
    });
  });

  // ---- A5: gfx-trim 0-boundary table ------------------------------------
  //
  // A frame field in `gfxMetrics` is redundant with `performanceAudit.metrics`
  // only when the audit actually carries a replacement. `0` is a REAL
  // measurement (zero missed vsyncs), not "missing", so a `0` audit value must
  // still drop the redundant gfx field. An `if (metrics.x)` refactor treats `0`
  // as falsy and re-ships the redundancy — this table is the guard.
  describe("gfx-trim 0-boundary table (A5)", () => {
    const GFX_AUDIT_PAIRS: ReadonlyArray<readonly [string, string]> = [
      ["p50Ms", "percentile50thMs"],
      ["p90Ms", "percentile90thMs"],
      ["p95Ms", "percentile95thMs"],
      ["p99Ms", "percentile99thMs"],
      ["missedVsyncCount", "missedVsyncCount"],
      ["slowUiThreadCount", "slowUiThreadCount"],
      ["frameDeadlineMissedCount", "frameDeadlineMissedCount"],
    ];

    function fullGfxMetrics(): NonNullable<ObserveResult["gfxMetrics"]> {
      return {
        packageName: "com.example.app",
        percentile50thMs: 12,
        percentile90thMs: 18,
        percentile95thMs: 22,
        percentile99thMs: 30,
        missedVsyncCount: 1,
        slowUiThreadCount: 1,
        frameDeadlineMissedCount: 0,
        pollCount: 7,
        stabilityWaitMs: 350,
        isStable: true,
      };
    }

    test.each(GFX_AUDIT_PAIRS)(
      "a 0-valued audit %s still drops redundant gfxMetrics.%s",
      (auditKey, gfxKey) => {
        const { observe } = loadAndroidHomeObserve();
        const m = observe.performanceAudit!.metrics as unknown as Record<string, unknown>;
        // Null every frame replacement so ONLY the tested field's 0 can drive a drop.
        for (const [ak] of GFX_AUDIT_PAIRS) {
          m[ak] = null;
        }
        m[auditKey] = 0; // a genuine measurement of zero, not "no data"
        observe.gfxMetrics = fullGfxMetrics();

        const out = sanitizeObserveResult(observe, DROP_NONE);

        expect(out.gfxMetrics).not.toHaveProperty(gfxKey);
      },
    );

    test("keeps every non-frame UI-stability gfxMetrics field", () => {
      const { observe } = loadAndroidHomeObserve();
      observe.gfxMetrics = fullGfxMetrics();
      const out = sanitizeObserveResult(observe, DROP_NONE);
      // The action UI-stability fields are not perf-audit duplicates → retained.
      expect(out.gfxMetrics).toMatchObject({
        packageName: "com.example.app",
        pollCount: 7,
        stabilityWaitMs: 350,
        isStable: true,
      });
    });
  });

  // ---- A6: GFXINFO diagnostics-marker boundaries ------------------------
  describe("GFXINFO diagnostics-marker boundaries (A6)", () => {
    function strippedDiagnostics(diagnostics: string): string {
      const { observe } = loadAndroidHomeObserve();
      observe.performanceAudit!.diagnostics = diagnostics;
      return sanitizeObserveResult(observe, DROP_NONE).performanceAudit!.diagnostics!;
    }

    test("a marker at index 0 truncates diagnostics to the empty string", () => {
      // The whole diagnostics string is the dump; nothing survives above it.
      expect(strippedDiagnostics(`${GFXINFO_DUMP_MARKER}\nraw dump line\nmore`)).toBe("");
    });

    test("an absent marker leaves diagnostics untouched", () => {
      expect(strippedDiagnostics("Summary only, no dump present")).toBe(
        "Summary only, no dump present",
      );
    });

    test("a marker mid-string keeps the summary above it and drops the dump", () => {
      const diag = strippedDiagnostics(
        `Performance issues detected:\nline\n${GFXINFO_DUMP_MARKER}\nraw`,
      );
      expect(diag).toBe("Performance issues detected:\nline");
      expect(diag).not.toContain(GFXINFO_DUMP_MARKER);
    });
  });

  // ---- A10: unicode preservation through trim + compact -----------------
  //
  // The slice had zero non-ASCII coverage. Trim/compact must never corrupt or
  // drop multi-byte, astral (surrogate-pair), or zero-width text.
  describe("unicode text preservation (A10)", () => {
    function trimmedCompactNode(attrs: Record<string, unknown>): Record<string, unknown> {
      const obs: ObserveResult = {
        updatedAt: 0,
        screenSize: { width: 1, height: 1 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: { node: { "resource-id": "r", ...attrs, node: [], $: {} } as any },
        },
      };
      return sanitizeObserveResult(obs, COMPACT).viewHierarchy!.hierarchy!
        .node as unknown as Record<string, unknown>;
    }

    const UNICODE_TEXTS: ReadonlyArray<readonly [string, string]> = [
      ["combining/NFD accent", "café"],
      ["precomposed/NFC accent", "café"],
      ["astral ZWJ family emoji", "\u{1F468}‍\u{1F469}‍\u{1F467}"],
      ["flag (regional indicators)", "\u{1F1FA}\u{1F1F8}"],
      ["zero-width joiner inside text", "a‍b"],
      ["CJK", "設定"],
    ];

    test.each(UNICODE_TEXTS)(
      "preserves %s in text verbatim through trim+compact",
      (_label, text) => {
        expect(trimmedCompactNode({ text })["text"]).toBe(text);
      },
    );

    test("NFC and NFD forms are preserved as distinct byte sequences (no normalization)", () => {
      const nfc = trimmedCompactNode({ text: "café" })["text"];
      const nfd = trimmedCompactNode({ text: "café" })["text"];
      expect(nfc).not.toBe(nfd);
    });
  });

  // ---- P1: reduction table ("measurably shrinks" siblings) --------------
  //
  // Every reduction must shrink the payload it targets, and — the boundary the
  // audit flags — must NEVER grow an observation that lacks the field. `tokensToo`
  // is `false` for view-id dedup: it removes a duplicate id string that shrinks
  // bytes without necessarily removing a token.
  describe("reduction table (P1)", () => {
    interface ReductionRow {
      label: string;
      reduced: () => unknown;
      reference: () => unknown;
      tokensToo: boolean;
    }

    const ROWS: ReductionRow[] = [
      {
        // Isolate the perf-audit strip: reference is the fully-sanitized output
        // with ONLY the raw `performanceAudit` restored, so the sole difference is
        // stripPerformanceAudit's work. Comparing against the raw fixture instead
        // (as before) stayed green on independent perfTiming-drop + node-trim even
        // if the strip regressed to a no-op.
        label: "perf-audit strip",
        reduced: () => sanitizeObserveResult(loadAndroidHomeObserve().observe, DROP_NONE),
        reference: () => {
          const { observe } = loadAndroidHomeObserve();
          return {
            ...sanitizeObserveResult(observe, DROP_NONE),
            performanceAudit: observe.performanceAudit,
          };
        },
        tokensToo: true,
      },
      {
        label: "drop perfTiming",
        reduced: () => sanitizeObserveResult(loadAndroidHomeObserve().observe, DROP_NONE),
        reference: () => {
          const { observe } = loadAndroidHomeObserve();
          return { ...sanitizeObserveResult(observe, DROP_NONE), perfTiming: observe.perfTiming };
        },
        tokensToo: true,
      },
      {
        label: "elements drop",
        reduced: () => sanitizeObserveResult(loadAndroidHomeObserve().observe, DROP_ELEMENTS),
        reference: () => sanitizeObserveResult(loadAndroidHomeObserve().observe, DROP_NONE),
        tokensToo: true,
      },
      {
        label: "compact bounds",
        reduced: () => sanitizeObserveResult(loadAndroidHomeObserve().observe, COMPACT),
        reference: () => sanitizeObserveResult(loadAndroidHomeObserve().observe, DROP_NONE),
        tokensToo: true,
      },
      {
        label: "skeleton projection",
        reduced: () =>
          sanitizeObserveResult(loadAndroidHomeObserve().observe, {
            dropElements: false,
            project: "skeleton",
          }),
        reference: () => sanitizeObserveResult(loadAndroidHomeObserve().observe, DROP_NONE),
        tokensToo: true,
      },
      {
        label: "node trim (view-id dedup)",
        reduced: () => sanitizeObserveResult(loadAndroidHomeObserve().observe, DROP_NONE),
        reference: () =>
          sanitizeObserveResult(loadAndroidHomeObserve().observe, {
            dropElements: false,
            trimNodes: false,
          }),
        // View-id dedup removes a duplicate id string: bytes shrink, tokens may not.
        tokensToo: false,
      },
      {
        label: "combined (perf + elements + trim)",
        reduced: () => sanitizeObserveResult(loadAndroidHomeObserve().observe, DROP_ELEMENTS),
        reference: () => loadAndroidHomeObserve().observe,
        tokensToo: true,
      },
    ];

    test.each(ROWS)(
      "$label measurably shrinks the payload",
      ({ reduced, reference, tokensToo }) => {
        const r = measureValue(reduced());
        const ref = measureValue(reference());
        expect(r.bytes).toBeLessThan(ref.bytes);
        if (tokensToo) {
          expect(r.tokens).toBeLessThan(ref.tokens);
        } else {
          expect(r.tokens).toBeLessThanOrEqual(ref.tokens);
        }
      },
    );

    // Boundary: a reduction applied to an observation LACKING its target field
    // must be a no-op — never grow the payload.
    const BARE: ObserveResult = {
      updatedAt: 0,
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { hierarchy: { node: { "resource-id": "r", node: [], $: {} } as any } },
    };

    test("compact on a bounds-free observation does not grow it", () => {
      const compacted = sanitizeObserveResult(BARE, COMPACT);
      const plain = sanitizeObserveResult(BARE, DROP_NONE);
      expect(measureValue(compacted).bytes).toBeLessThanOrEqual(measureValue(plain).bytes);
    });

    test("dropElements on an elements-free observation does not grow it", () => {
      const dropped = sanitizeObserveResult(BARE, DROP_ELEMENTS);
      const kept = sanitizeObserveResult(BARE, DROP_NONE);
      expect(measureValue(dropped).bytes).toBeLessThanOrEqual(measureValue(kept).bytes);
    });
  });
});
