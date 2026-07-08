import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  classifyObservationAction,
  finalizeToolResponse,
} from "../../src/server/finalizeToolResponse";
import {
  createStructuredToolResponse,
  stringifyToolResponse,
  type StructuredToolResponse,
} from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import { GFXINFO_DUMP_MARKER } from "../../src/features/observe/output/ObserveResultOutput";
import type { ObserveResult } from "../../src/models/ObserveResult";

/**
 * Build a minimal ObserveResult whose hierarchy carries trimmable attributes:
 * an empty-string field, a default-false boolean, and a `view-id` that
 * duplicates `resource-id`. sanitizeObserveResult should drop all three.
 */
function makeObserveResult(): ObserveResult {
  return {
    updatedAt: 123,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: {
      hierarchy: {
        node: {
          "resource-id": "com.example:id/root",
          "view-id": "com.example:id/root", // duplicate → dropped
          "text": "", // empty → dropped
          "clickable": "false", // default-false boolean → dropped
          "content-desc": "keep-me",
          "node": [
            {
              "resource-id": "com.example:id/child",
              "text": "Hello",
              "focusable": "false", // dropped
            } as any,
          ],
        } as any,
      },
    },
    elements: {
      clickable: [{ text: "btn" } as any],
      scrollable: [],
      text: [],
      media: [],
    },
  } as ObserveResult;
}

/** ObserveResult whose root node carries an object-shaped `bounds`. */
function makeObserveResultWithBounds(): ObserveResult {
  return {
    updatedAt: 123,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: {
      hierarchy: {
        node: {
          "resource-id": "com.example:id/root",
          "bounds": { left: 0, top: 0, right: 1080, bottom: 1920 },
          "node": [
            { "resource-id": "com.example:id/child", "bounds": { left: 10, top: 20, right: 30, bottom: 40 } } as any,
          ],
        } as any,
      },
    },
  } as ObserveResult;
}

describe("finalizeToolResponse", () => {
  let originalDropElements: boolean;
  let originalCompact: boolean;

  beforeEach(() => {
    originalDropElements = serverConfig.isObserveResultDropElementsEnabled();
    originalCompact = serverConfig.isObserveResultCompactEnabled();
    serverConfig.setObserveResultDropElementsEnabled(false);
    serverConfig.setObserveResultCompactEnabled(false);
  });

  afterEach(() => {
    serverConfig.setObserveResultDropElementsEnabled(originalDropElements);
    serverConfig.setObserveResultCompactEnabled(originalCompact);
  });

  test("EC1: observe response is sanitized in both structuredContent and text", () => {
    const obs = makeObserveResult();
    const response = createStructuredToolResponse(obs);

    const finalized = finalizeToolResponse(response, { name: "observe", sessionUuid: "s1" });

    const rootSc = (finalized.structuredContent as ObserveResult).viewHierarchy!.hierarchy.node as any;
    // Trimmed: duplicate view-id, empty text, default-false clickable all gone.
    expect(rootSc["view-id"]).toBeUndefined();
    expect(rootSc.text).toBeUndefined();
    expect(rootSc.clickable).toBeUndefined();
    // Preserved: content-desc and resource-id.
    expect(rootSc["content-desc"]).toBe("keep-me");
    expect(rootSc["resource-id"]).toBe("com.example:id/root");
    // Child trimmed too.
    expect(rootSc.node[0].focusable).toBeUndefined();
    expect(rootSc.node[0].text).toBe("Hello");

    // EC7: text mirrors the sanitized structuredContent exactly.
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    const rootText = JSON.parse(finalized.content[0].text).viewHierarchy.hierarchy.node;
    expect(rootText["view-id"]).toBeUndefined();
  });

  test("EC2: action response has its .observation sanitized in both text and structuredContent", () => {
    const obs = makeObserveResult();
    const actionPayload = { success: true, observation: obs };
    const response = createStructuredToolResponse(actionPayload);

    const finalized = finalizeToolResponse(response, { name: "tapOn", sessionUuid: "s1" });

    const obsSc = (finalized.structuredContent as any).observation as ObserveResult;
    const rootSc = obsSc.viewHierarchy!.hierarchy.node as any;
    expect(rootSc["view-id"]).toBeUndefined();
    expect(rootSc.clickable).toBeUndefined();
    expect((finalized.structuredContent as any).success).toBe(true);

    const parsed = JSON.parse(finalized.content[0].text);
    expect(parsed.observation.viewHierarchy.hierarchy.node["view-id"]).toBeUndefined();
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("EC4: elements are dropped only when the gate is enabled", () => {
    serverConfig.setObserveResultDropElementsEnabled(false);
    const keep = finalizeToolResponse(createStructuredToolResponse(makeObserveResult()), { name: "observe" });
    expect((keep.structuredContent as ObserveResult).elements).toBeDefined();

    serverConfig.setObserveResultDropElementsEnabled(true);
    const drop = finalizeToolResponse(createStructuredToolResponse(makeObserveResult()), { name: "observe" });
    expect((drop.structuredContent as ObserveResult).elements).toBeUndefined();
    expect(JSON.parse(drop.content[0].text).elements).toBeUndefined();
  });

  test("EC6: the caller's in-memory ObserveResult is never mutated", () => {
    const obs = makeObserveResult();
    const response = createStructuredToolResponse(obs);
    // The handler's own result object is the structuredContent reference.
    finalizeToolResponse(response, { name: "observe" });

    // Original object still carries the redundant fields — sanitize is output-only.
    const originalRoot = obs.viewHierarchy!.hierarchy.node as any;
    expect(originalRoot["view-id"]).toBe("com.example:id/root");
    expect(originalRoot.clickable).toBe("false");
    expect(obs.elements).toBeDefined();
  });

  test("EC5: non-observe/non-observation responses pass through unchanged", () => {
    const payload = { success: true, message: "done" };
    const response = createStructuredToolResponse(payload);
    const finalized = finalizeToolResponse(response, { name: "pressButton" });
    expect(finalized.structuredContent).toEqual(payload);
    expect(finalized.content[0].text).toBe(stringifyToolResponse(payload));
  });

  test("EC5: image responses (no text part) pass through unchanged", () => {
    const imageResponse: any = {
      content: [{ type: "image", data: "base64==", mimeType: "image/png" }],
    };
    const finalized = finalizeToolResponse(imageResponse, { name: "observe" });
    expect(finalized).toBe(imageResponse);
    expect(finalized.content[0].type).toBe("image");
  });

  test("EC5: non-JSON text-only responses pass through unchanged", () => {
    const textResponse: any = { content: [{ type: "text", text: "not json at all" }] };
    const finalized = finalizeToolResponse(textResponse, { name: "observe" });
    expect(finalized.content[0].text).toBe("not json at all");
  });

  test("EC5: null / primitive responses are returned as-is", () => {
    expect(finalizeToolResponse(null, { name: "observe" })).toBeNull();
    expect(finalizeToolResponse(undefined, { name: "observe" })).toBeUndefined();
    expect(finalizeToolResponse("plain", { name: "observe" })).toBe("plain");
  });

  test("observe payload without a viewHierarchy still strips perfTiming", () => {
    const payload: any = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: {},
      perfTiming: [{ name: "observe", durationMs: 12 }],
      perfTimingTruncated: true,
    };
    const response = createStructuredToolResponse(payload);

    const finalized = finalizeToolResponse(response, { name: "observe" });

    expect((finalized.structuredContent as any).perfTiming).toBeUndefined();
    expect((finalized.structuredContent as any).perfTimingTruncated).toBe(true);
    expect(payload.perfTiming).toBeDefined();
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("action observation without a viewHierarchy still strips perfTiming", () => {
    const observation: any = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: {},
      perfTiming: [{ name: "tapOn", durationMs: 12 }],
    };
    const response = createStructuredToolResponse({ success: true, observation });

    const finalized = finalizeToolResponse(response, { name: "tapOn" });

    expect((finalized.structuredContent as any).observation.perfTiming).toBeUndefined();
    expect(observation.perfTiming).toBeDefined();
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("strips the performance-audit raw dumps and truncates diagnostics at the GFXINFO marker", () => {
    const obs = makeObserveResult();
    (obs as any).performanceAudit = {
      metrics: { gfxinfoRaw: "HUGE RAW DUMP", cpuStatsRaw: "CPU RAW", p99: 16 },
      diagnostics: `summary line\n${GFXINFO_DUMP_MARKER}\nmegabytes of raw frame data`,
    };
    const finalized = finalizeToolResponse(createStructuredToolResponse(obs), { name: "observe" });

    const audit = (finalized.structuredContent as any).performanceAudit;
    expect(audit.metrics.gfxinfoRaw).toBeNull();
    expect(audit.metrics.cpuStatsRaw).toBeNull();
    expect(audit.metrics.p99).toBe(16); // computed metric preserved
    expect(audit.diagnostics).toBe("summary line");
    // Original in-memory audit is untouched (output-only).
    expect((obs as any).performanceAudit.metrics.gfxinfoRaw).toBe("HUGE RAW DUMP");
  });

  test("preserves the observe-only awaitedElement extras spread into the payload", () => {
    const obs = makeObserveResult();
    const withExtras = { ...obs, awaitedElement: { text: "Found" }, awaitDuration: 250, awaitTimeout: false };
    const finalized = finalizeToolResponse(createStructuredToolResponse(withExtras), { name: "observe" });

    const sc = finalized.structuredContent as any;
    expect(sc.awaitedElement).toEqual({ text: "Found" });
    expect(sc.awaitDuration).toBe(250);
    // Hierarchy still trimmed alongside the preserved extras.
    expect(sc.viewHierarchy.hierarchy.node["view-id"]).toBeUndefined();
  });

  test("drops elements on an action's nested .observation when the gate is enabled", () => {
    serverConfig.setObserveResultDropElementsEnabled(true);
    const response = createStructuredToolResponse({ success: true, observation: makeObserveResult() });
    const finalized = finalizeToolResponse(response, { name: "tapOn" });
    expect((finalized.structuredContent as any).observation.elements).toBeUndefined();
    expect(JSON.parse(finalized.content[0].text).observation.elements).toBeUndefined();
  });

  test("trims an array-shaped root node (both roots)", () => {
    const obs = makeObserveResult();
    obs.viewHierarchy!.hierarchy.node = [
      { "resource-id": "a", "view-id": "a", "clickable": "false" } as any,
      { "resource-id": "b", "view-id": "b", "focusable": "false" } as any,
    ] as any;
    const finalized = finalizeToolResponse(createStructuredToolResponse(obs), { name: "observe" });
    const roots = (finalized.structuredContent as any).viewHierarchy.hierarchy.node;
    expect(roots[0]["view-id"]).toBeUndefined();
    expect(roots[0].clickable).toBeUndefined();
    expect(roots[1]["view-id"]).toBeUndefined();
    expect(roots[1].focusable).toBeUndefined();
  });

  test("falls back to content text when structuredContent is absent", () => {
    const obs = makeObserveResult();
    const textOnly: any = { content: [{ type: "text", text: JSON.stringify(obs) }] };
    const finalized = finalizeToolResponse(textOnly, { name: "observe" });
    const root = JSON.parse(finalized.content[0].text).viewHierarchy.hierarchy.node;
    expect(root["view-id"]).toBeUndefined();
    expect(root.clickable).toBeUndefined();
  });

  test("EC-C: compact flag flattens node bounds in both structuredContent and text when the gate is on", () => {
    serverConfig.setObserveResultCompactEnabled(true);
    const finalized = finalizeToolResponse(
      createStructuredToolResponse(makeObserveResultWithBounds()),
      { name: "observe" }
    );

    const rootSc = (finalized.structuredContent as any).viewHierarchy.hierarchy.node;
    expect(rootSc.bounds).toEqual([0, 0, 1080, 1920]);
    expect(rootSc.node[0].bounds).toEqual([10, 20, 30, 40]);

    const rootText = JSON.parse(finalized.content[0].text).viewHierarchy.hierarchy.node;
    expect(rootText.bounds).toEqual([0, 0, 1080, 1920]);
    // Text mirrors structuredContent exactly.
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("EC-C: compact flattens bounds on an action's nested .observation (tapOn path)", () => {
    serverConfig.setObserveResultCompactEnabled(true);
    const response = createStructuredToolResponse({ success: true, observation: makeObserveResultWithBounds() });
    const finalized = finalizeToolResponse(response, { name: "tapOn", sessionUuid: "s1" });

    const obsSc = (finalized.structuredContent as any).observation;
    expect(obsSc.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
    expect(obsSc.viewHierarchy.hierarchy.node.node[0].bounds).toEqual([10, 20, 30, 40]);
    expect((finalized.structuredContent as any).success).toBe(true);

    // Text mirrors the sanitized structuredContent exactly on the .observation branch too.
    const parsed = JSON.parse(finalized.content[0].text);
    expect(parsed.observation.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("EC-C: compact gate off keeps object-shaped bounds (today's shape)", () => {
    serverConfig.setObserveResultCompactEnabled(false);
    const finalized = finalizeToolResponse(
      createStructuredToolResponse(makeObserveResultWithBounds()),
      { name: "observe" }
    );
    const rootSc = (finalized.structuredContent as any).viewHierarchy.hierarchy.node;
    expect(Array.isArray(rootSc.bounds)).toBe(false);
    expect(rootSc.bounds).toEqual({ left: 0, top: 0, right: 1080, bottom: 1920 });
  });

  test("EC-C: compact is output-only — the caller's in-memory bounds object is untouched", () => {
    serverConfig.setObserveResultCompactEnabled(true);
    const obs = makeObserveResultWithBounds();
    finalizeToolResponse(createStructuredToolResponse(obs), { name: "observe" });
    expect(obs.viewHierarchy!.hierarchy.node).not.toBeInstanceOf(Array);
    expect((obs.viewHierarchy!.hierarchy.node as any).bounds).toEqual({ left: 0, top: 0, right: 1080, bottom: 1920 });
  });

  test("EC-C: compact composes with drop-elements and the wire-strip flag (all three on)", () => {
    serverConfig.setObserveResultCompactEnabled(true);
    serverConfig.setObserveResultDropElementsEnabled(true);
    const originalStrip = serverConfig.isToolResultsNoStructuredContentEnabled();
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    try {
      const obs = { ...makeObserveResultWithBounds(), elements: { clickable: [], scrollable: [], text: [], media: [] } };
      const finalized = finalizeToolResponse(createStructuredToolResponse(obs), { name: "observe" });
      const sc = finalized.structuredContent as any;
      // finalize keeps structuredContent (the strip is a later wire-boundary concern).
      expect(sc).toBeDefined();
      expect(sc.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
      expect(sc.elements).toBeUndefined();
    } finally {
      serverConfig.setToolResultsNoStructuredContentEnabled(originalStrip);
    }
  });

  test("EC-B: finalize never strips structuredContent (that is a wire-boundary concern)", () => {
    // Even with the strip flag on, finalizeToolResponse keeps structuredContent so
    // internal handler callers (e.g. DefaultUIStateSetup's swipeOn found-detection)
    // can still read it — the strip is applied later, only at the MCP boundary.
    const originalStrip = serverConfig.isToolResultsNoStructuredContentEnabled();
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    try {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(makeObserveResult()),
        { name: "observe" }
      );
      expect(finalized.structuredContent).toBeDefined();
    } finally {
      serverConfig.setToolResultsNoStructuredContentEnabled(originalStrip);
    }
  });

  // Composition of --observe-result-compact with --actions-diff-observe (issue #2990).
  // The diff behavior itself shipped in #2761 (see the "actions-diff-observe diff
  // emit" block below): the diff runs *inside* `finalizeToolResponse`, *after*
  // `sanitizeObserveResult`/compaction, and only when a `baselineStore` is injected.
  // These two cases pin the compaction invariants that must survive that — note they
  // pass a `sessionUuid` but NO `baselineStore`, so no diff is produced and the full
  // (compacted) observation is emitted, exactly today's behavior:
  //   1. Enabling the diff flag never disables (or is a precondition for) compaction —
  //      compaction is gated solely by `isObserveResultCompactEnabled()`.
  //   2. When compaction is off, a post-action observation keeps object-shaped bounds,
  //      so a field-by-field `bounds.left` reader is never handed a tuple.
  // The diff-and-compact interaction (a served diff carrying tuple bounds) is covered
  // by "compact on: the emitted diff carries tuple-shaped bounds" in the diff-emit block.
  describe("compact × actions-diff-observe composition (#2990)", () => {
    let originalDiff: boolean;

    beforeEach(() => {
      originalDiff = serverConfig.isActionsDiffObserveEnabled();
    });

    afterEach(() => {
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
    });

    test("EC-D1: compact still flattens a post-action .observation when the diff flag is also on", () => {
      serverConfig.setObserveResultCompactEnabled(true);
      serverConfig.setActionsDiffObserveEnabled(true);

      const response = createStructuredToolResponse({ success: true, observation: makeObserveResultWithBounds() });
      const finalized = finalizeToolResponse(response, { name: "tapOn", sessionUuid: "s1" });

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
      expect(obsSc.viewHierarchy.hierarchy.node.node[0].bounds).toEqual([10, 20, 30, 40]);
      expect((finalized.structuredContent as any).success).toBe(true);

      // Text mirrors the sanitized structuredContent exactly on the diffed .observation branch.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    });

    test("EC-D2: the diff flag alone (compact off) never compacts — bounds stay object-shaped for a field-by-field differ", () => {
      serverConfig.setObserveResultCompactEnabled(false);
      serverConfig.setActionsDiffObserveEnabled(true);

      const response = createStructuredToolResponse({ success: true, observation: makeObserveResultWithBounds() });
      const finalized = finalizeToolResponse(response, { name: "tapOn" });

      const node = (finalized.structuredContent as any).observation.viewHierarchy.hierarchy.node;
      expect(Array.isArray(node.bounds)).toBe(false);
      expect(node.bounds).toEqual({ left: 0, top: 0, right: 1080, bottom: 1920 });
      // A differ reading `bounds.left`/`bounds.top` field-by-field sees numbers, not undefined.
      expect(node.bounds.left).toBe(0);
      expect(node.bounds.bottom).toBe(1920);
    });
  });

  // Diff emit (issue #2761): with `--actions-diff-observe` on AND a baseline
  // store injected, a non-observe action emits a *diff* of its post-action
  // observation instead of the full observation. `observe` always emits full and
  // resets the baseline. Falls back to full when the screen changed, the baseline
  // is missing, or there is no sessionUuid (legacy single-agent path).
  describe("actions-diff-observe diff emit (#2761)", () => {
    let originalDiff: boolean;

    /** Same-screen ObserveResult (app/activity/package all match makeObserveResult). */
    function sameScreenObserve(): ObserveResult {
      return {
        ...makeObserveResult(),
        activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.example",
          hierarchy: {
            node: {
              "resource-id": "com.example:id/root",
              "content-desc": "keep-me",
              "node": [{ "resource-id": "com.example:id/child", "text": "Hello" } as any],
            } as any,
          },
        },
      } as ObserveResult;
    }

    /** In-memory baseline store standing in for the sessionManager cache slot. */
    function makeStore(): { store: { get: (u: string) => ObserveResult | undefined; set: (u: string, o: ObserveResult) => void }; map: Map<string, ObserveResult> } {
      const map = new Map<string, ObserveResult>();
      return {
        map,
        store: {
          get: (u: string) => map.get(u),
          set: (u: string, o: ObserveResult) => { map.set(u, o); },
        },
      };
    }

    function expectObservationDiff(
      finalized: { structuredContent?: unknown; content: Array<{ text: string }> },
      expected: Record<string, unknown>
    ): any {
      const metadata = (finalized.structuredContent as any).observationDiff;
      expect(metadata).toMatchObject(expected);
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observationDiff).toEqual(metadata);
      return metadata;
    }

    function iosScreenObserve(
      key: string,
      confidence: "high" | "medium" | "low" = "high"
    ): ObserveResult {
      return {
        ...sameScreenObserve(),
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 0 },
        screenIdentity: {
          platform: "ios",
          source: "heuristic",
          confidence,
          key,
          components: {
            bundleId: "com.apple.reminders",
            navigationTitle: key,
          },
        },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: sameScreenObserve().viewHierarchy!.hierarchy,
        },
      } as ObserveResult;
    }

    function checkedIosScreenObserve(
      key: string,
      confidence: "high" | "medium" | "low" = "high"
    ): ObserveResult {
      const observation = iosScreenObserve(key, confidence);
      (observation.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      return observation;
    }

    function finalizeChangedLowConfidenceAction(
      name: string,
      actionArgs: Record<string, unknown>,
      key = "bundle=com.apple.reminders|focus=Title"
    ): StructuredToolResponse<{ success: boolean; observation: ObserveResult }> {
      const { store } = makeStore();
      const baseline = iosScreenObserve(key, "low");
      finalizeToolResponse(
        createStructuredToolResponse(baseline),
        { name: "observe", sessionUuid: "s1", baselineStore: store }
      );

      return finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: checkedIosScreenObserve(key, "low") }),
        {
          name,
          actionClass: classifyObservationAction(name, actionArgs),
          sessionUuid: "s1",
          baselineStore: store,
        }
      );
    }

    beforeEach(() => {
      originalDiff = serverConfig.isActionsDiffObserveEnabled();
      serverConfig.setActionsDiffObserveEnabled(true);
    });

    afterEach(() => {
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
    });

    test("flag off leaves the action observation full and never touches the store", () => {
      serverConfig.setActionsDiffObserveEnabled(false);
      const { store, map } = makeStore();
      const response = createStructuredToolResponse({ success: true, observation: sameScreenObserve() });
      const finalized = finalizeToolResponse(response, { name: "tapOn", sessionUuid: "s1", baselineStore: store });

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "disabled" });
      expect(map.size).toBe(0);
    });

    test("observe emits the full observation and resets the baseline", () => {
      const { store, map } = makeStore();
      const finalized = finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      // Full observation emitted (not a diff).
      expect((finalized.structuredContent as any).isDiff).toBeUndefined();
      expect((finalized.structuredContent as any).viewHierarchy).toBeDefined();
      // Baseline reset to the sanitized observation.
      expect(map.get("s1")).toBeDefined();
      expect(map.get("s1")!.viewHierarchy).toBeDefined();
    });

    test("a non-observe action emits a diff vs the baseline in both representations", () => {
      const { store } = makeStore();
      // Seed the baseline via an observe.
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), { name: "observe", sessionUuid: "s1", baselineStore: store });

      // Next action toggles a child's `checked` on the same screen.
      const next = sameScreenObserve();
      (next.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.viewHierarchy).toBeUndefined();
      expect(obsSc.changed).toHaveLength(1);
      expect(obsSc.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
      expect((finalized.structuredContent as any).success).toBe(true);
      expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });

      // Text mirrors the diffed structuredContent exactly.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.isDiff).toBe(true);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    });

    test("hierarchy-less action observations emit full sanitized payloads, not empty diffs", () => {
      const { store, map } = makeStore();
      const baseline = sameScreenObserve();
      finalizeToolResponse(createStructuredToolResponse(baseline), { name: "observe", sessionUuid: "s1", baselineStore: store });

      const hierarchyLess = (durationMs: number): ObserveResult => ({
        updatedAt: durationMs,
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        freshness: { isFresh: true },
        errors: [{ phase: "viewHierarchy", message: "service unavailable" } as any],
        perfTiming: [{ name: "observe", durationMs }],
      });

      const first = finalizeToolResponse(
        createStructuredToolResponse({ success: false, observation: hierarchyLess(12) }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );
      const second = finalizeToolResponse(
        createStructuredToolResponse({ success: false, observation: hierarchyLess(13) }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );

      const firstObs = (first.structuredContent as any).observation;
      const secondObs = (second.structuredContent as any).observation;
      expect(firstObs.isDiff).toBeUndefined();
      expect(secondObs.isDiff).toBeUndefined();
      expectObservationDiff(first, { mode: "full", reason: "unrenderable_hierarchy" });
      expectObservationDiff(second, { mode: "full", reason: "unrenderable_hierarchy" });
      expect(firstObs.errors[0].message).toBe("service unavailable");
      expect(secondObs.errors[0].message).toBe("service unavailable");
      expect(firstObs.perfTiming).toBeUndefined();
      expect(secondObs.perfTiming).toBeUndefined();
      expect(map.get("s1")).toBeDefined();
      expect(map.get("s1")!.viewHierarchy).toBeDefined();
      expect(first.content[0].text).toBe(stringifyToolResponse(first.structuredContent));
      expect(second.content[0].text).toBe(stringifyToolResponse(second.structuredContent));
    });

    test("falls back to full when the stored baseline has no renderable hierarchy", () => {
      const { store, map } = makeStore();
      map.set("s1", {
        updatedAt: 1,
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
        viewHierarchy: { packageName: "com.example" } as any,
      } as ObserveResult);

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      const metadata = expectObservationDiff(finalized, { mode: "full", reason: "unrenderable_hierarchy" });
      expect(metadata.fromScreen.activeWindow.appId).toBe("com.example");
      expect(metadata.toScreen.activeWindow.appId).toBe("com.example");
      expect(map.get("s1")!.viewHierarchy?.hierarchy).toBeDefined();
    });

    test("a non-observe action updates the baseline to its own observation (next diff is against current state)", () => {
      const { store, map } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), { name: "observe", sessionUuid: "s1", baselineStore: store });

      const next = sameScreenObserve();
      (next.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      finalizeToolResponse(createStructuredToolResponse({ success: true, observation: next }), { name: "tapOn", sessionUuid: "s1", baselineStore: store });

      // Baseline now reflects the post-action observation (checked=true present).
      const baseline = map.get("s1")!;
      expect((baseline.viewHierarchy!.hierarchy.node as any).node[0].checked).toBe("true");
    });

    test("falls back to the full observation when the baseline is missing", () => {
      const { store, map } = makeStore();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );
      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "missing_baseline" });
      // Baseline is now seeded for the next action.
      expect(map.get("s1")).toBeDefined();
    });

    test("falls back to the full observation when the session baseline store is missing", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1" }
      );
      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "missing_session" });
    });

    test("falls back to full when the screen (app/activity/package) changed", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), { name: "observe", sessionUuid: "s1", baselineStore: store });

      const otherScreen = {
        ...sameScreenObserve(),
        activeWindow: { appId: "com.other", activityName: ".Other", layoutSeqSum: 2 },
      } as ObserveResult;
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: otherScreen }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );
      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      const metadata = expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
      expect(metadata.fromScreen.activeWindow.appId).toBe("com.example");
      expect(metadata.toScreen.activeWindow.appId).toBe("com.other");
    });

    test("falls back to full when an iOS screen identity changes under the same app", () => {
      const { store } = makeStore();
      const baseline = iosScreenObserve("bundle=com.apple.reminders|nav=Reminders");
      finalizeToolResponse(createStructuredToolResponse(baseline), { name: "observe", sessionUuid: "s1", baselineStore: store });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|nav=New Reminder");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expect(obsSc.screenIdentity.key).toBe("bundle=com.apple.reminders|nav=New Reminder");
      const metadata = expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
      expect(metadata.fromScreen.screenIdentity.key).toBe("bundle=com.apple.reminders|nav=Reminders");
      expect(metadata.toScreen.screenIdentity.key).toBe("bundle=com.apple.reminders|nav=New Reminder");
    });

    test("emits a diff when high-confidence iOS screen identity stays stable", () => {
      const { store } = makeStore();
      const baseline = iosScreenObserve("bundle=com.apple.reminders|nav=Reminders");
      finalizeToolResponse(createStructuredToolResponse(baseline), { name: "observe", sessionUuid: "s1", baselineStore: store });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|nav=Reminders");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
      expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });
    });

    test("preserves app/activity/package fallback when only one iOS identity is present", () => {
      const { store } = makeStore();
      finalizeToolResponse(
        createStructuredToolResponse(iosScreenObserve("bundle=com.apple.reminders|nav=Reminders")),
        { name: "observe", sessionUuid: "s1", baselineStore: store }
      );

      const next = {
        ...sameScreenObserve(),
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 0 },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: sameScreenObserve().viewHierarchy!.hierarchy,
        },
      } as ObserveResult;
      (next.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
    });

    test("falls back to full when medium-confidence iOS screen identity changes under the same app", () => {
      const { store } = makeStore();
      const baseline = iosScreenObserve("bundle=com.apple.reminders|tab=Inbox", "medium");
      finalizeToolResponse(createStructuredToolResponse(baseline), { name: "observe", sessionUuid: "s1", baselineStore: store });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|tab=Search", "medium");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expect(obsSc.screenIdentity.key).toBe("bundle=com.apple.reminders|tab=Search");
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("falls back to full and updates baseline when iOS screen identity is low confidence", () => {
      const { store, map } = makeStore();
      const baseline = iosScreenObserve("bundle=com.apple.reminders|focus=Title", "low");
      finalizeToolResponse(createStructuredToolResponse(baseline), { name: "observe", sessionUuid: "s1", baselineStore: store });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|focus=Title", "low");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
      expect((map.get("s1")!.viewHierarchy!.hierarchy.node as any).node[0].checked).toBe("true");
    });

    test("action policy: navigation-prone tap stays full on uncertain identity", () => {
      const finalized = finalizeChangedLowConfidenceAction("tapOn", { action: "tap" });

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("action policy: inputText diffs on stable surface despite uncertain identity", () => {
      const finalized = finalizeChangedLowConfidenceAction("inputText", { text: "hello" });

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
      expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });
    });

    test("action policy: swipeOn diffs on stable surface despite uncertain identity", () => {
      const finalized = finalizeChangedLowConfidenceAction(
        "swipeOn",
        { direction: "up" },
        "bundle=com.apple.reminders|list=Inbox"
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
      expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });
    });

    test("classifies non-observe actions for policy selection", () => {
      expect(classifyObservationAction("tapOn", { action: "tap" })).toBe("navigation");
      expect(classifyObservationAction("pressButton", { button: "back" })).toBe("navigation");
      expect(classifyObservationAction("pressButton", { button: "volume_up" })).toBe("inPlace");
      expect(classifyObservationAction("inputText", { text: "hello" })).toBe("inPlace");
      expect(classifyObservationAction("clearText", {})).toBe("inPlace");
      expect(classifyObservationAction("swipeOn", { direction: "up" })).toBe("scroll");
      expect(classifyObservationAction("dragAndDrop", {})).toBe("scroll");
    });

    test("falls back to full when there is no sessionUuid (legacy single-agent path)", () => {
      const { store, map } = makeStore();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", baselineStore: store }
      );
      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "missing_session" });
      expect(map.size).toBe(0);
    });

    test("observe resets the baseline after a diff-producing action", () => {
      const { store, map } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), { name: "observe", sessionUuid: "s1", baselineStore: store });
      const first = map.get("s1");
      // An observe with a different hierarchy overwrites the baseline wholesale.
      const reset = sameScreenObserve();
      (reset.viewHierarchy!.hierarchy.node as any)["content-desc"] = "changed-root";
      finalizeToolResponse(createStructuredToolResponse(reset), { name: "observe", sessionUuid: "s1", baselineStore: store });
      const second = map.get("s1")!;
      expect(second).not.toBe(first);
      expect((second.viewHierarchy!.hierarchy.node as any)["content-desc"]).toBe("changed-root");
    });

    test("diff path is output-only — the caller's in-memory observation is untouched", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), { name: "observe", sessionUuid: "s1", baselineStore: store });
      const next = sameScreenObserve();
      (next.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      const before = JSON.stringify(next);
      finalizeToolResponse(createStructuredToolResponse({ success: true, observation: next }), { name: "tapOn", sessionUuid: "s1", baselineStore: store });
      expect(JSON.stringify(next)).toBe(before);
    });

    test("compact on: the emitted diff carries tuple-shaped bounds in its node attributes", () => {
      // The diff runs on the sanitized (already-compacted) observation, so a node
      // surfaced in the diff carries the tuple bounds, not the object shape.
      serverConfig.setObserveResultCompactEnabled(true);
      const { store } = makeStore();
      const withBounds = (): ObserveResult => ({
        ...makeObserveResult(),
        activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.example",
          hierarchy: { node: { "resource-id": "com.example:id/root", "bounds": { left: 0, top: 0, right: 100, bottom: 100 } } as any },
        },
      } as ObserveResult);

      finalizeToolResponse(createStructuredToolResponse(withBounds()), { name: "observe", sessionUuid: "s1", baselineStore: store });

      const next = withBounds();
      (next.viewHierarchy!.hierarchy.node as any).node = [
        { "resource-id": "com.example:id/added", "bounds": { left: 5, top: 6, right: 7, bottom: 8 } },
      ];
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.added).toHaveLength(1);
      expect(obsSc.added[0].attributes.bounds).toEqual([5, 6, 7, 8]);
      expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });
    });
  });

  // --actions-no-observe (#2762, folded into #3026): strip the embedded
  // observation from non-observe tool results entirely. Precedence over
  // --actions-diff-observe — nothing to diff once stripped.
  describe("actions-no-observe strip + precedence (#2762/#3026)", () => {
    let originalNoObserve: boolean;
    let originalDiff: boolean;

    beforeEach(() => {
      originalNoObserve = serverConfig.isActionsNoObserveEnabled();
      originalDiff = serverConfig.isActionsDiffObserveEnabled();
      serverConfig.setActionsNoObserveEnabled(false);
      serverConfig.setActionsDiffObserveEnabled(false);
    });

    afterEach(() => {
      serverConfig.setActionsNoObserveEnabled(originalNoObserve);
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
    });

    test("strips the embedded observation from a non-observe action in both representations", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      const response = createStructuredToolResponse({ success: true, observation: makeObserveResult() });
      const finalized = finalizeToolResponse(response, { name: "tapOn", sessionUuid: "s1" });

      expect((finalized.structuredContent as any).observation).toBeUndefined();
      expect((finalized.structuredContent as any).observationDiff).toEqual({
        mode: "full",
        reason: "stripped_by_actions_no_observe",
      });
      expect((finalized.structuredContent as any).success).toBe(true);
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation).toBeUndefined();
      expect(parsed.observationDiff).toEqual((finalized.structuredContent as any).observationDiff);
      expect(parsed.success).toBe(true);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    });

    test("does not strip the observe tool's own observation", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      const finalized = finalizeToolResponse(createStructuredToolResponse(makeObserveResult()), { name: "observe", sessionUuid: "s1" });
      // observe still returns the full (sanitized) observation.
      expect((finalized.structuredContent as any).viewHierarchy).toBeDefined();
    });

    test("flag off leaves the observation in place (today's behavior)", () => {
      serverConfig.setActionsNoObserveEnabled(false);
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        { name: "tapOn" }
      );
      expect((finalized.structuredContent as any).observation).toBeDefined();
    });

    test("precedence: with both no-observe and diff on, the observation is stripped (no diff)", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      serverConfig.setActionsDiffObserveEnabled(true);
      const map = new Map<string, ObserveResult>();
      const store = { get: (u: string) => map.get(u), set: (u: string, o: ObserveResult) => { map.set(u, o); } };

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store }
      );
      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc).toBeUndefined(); // stripped, not a diff
      expect((finalized.structuredContent as any).observationDiff).toEqual({
        mode: "full",
        reason: "stripped_by_actions_no_observe",
      });
      // Diff moot → baseline never touched.
      expect(map.size).toBe(0);
    });

    test("non-observe tool without an observation passes through unchanged", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      const payload = { success: true, message: "done" };
      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), { name: "pressButton" });
      expect(finalized.structuredContent).toEqual(payload);
    });
  });

  // Internal tool-to-tool no-diff guard (issue #3053 part 2). PlanExecutor calls
  // the wrapped tool.handler (so finalize runs) with an injected sessionUuid, so a
  // plan step's envelope would get diffed / stripped when the flags are on. Reading
  // `.observation.viewHierarchy` off a diffed or stripped envelope would silently
  // break. `ctx.internal` forces the full sanitized observation regardless of flag.
  describe("internal no-diff guard (#3053)", () => {
    let originalDiff: boolean;
    let originalNoObserve: boolean;

    function sameScreenObserve(): ObserveResult {
      return {
        ...makeObserveResult(),
        activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.example",
          hierarchy: {
            node: {
              "resource-id": "com.example:id/root",
              "content-desc": "keep-me",
              "node": [{ "resource-id": "com.example:id/child", "text": "Hello" } as any],
            } as any,
          },
        },
      } as ObserveResult;
    }

    function makeStore(): { store: { get: (u: string) => ObserveResult | undefined; set: (u: string, o: ObserveResult) => void }; map: Map<string, ObserveResult> } {
      const map = new Map<string, ObserveResult>();
      return { map, store: { get: (u: string) => map.get(u), set: (u: string, o: ObserveResult) => { map.set(u, o); } } };
    }

    beforeEach(() => {
      originalDiff = serverConfig.isActionsDiffObserveEnabled();
      originalNoObserve = serverConfig.isActionsNoObserveEnabled();
    });

    afterEach(() => {
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
      serverConfig.setActionsNoObserveEnabled(originalNoObserve);
    });

    test("EC2.1: internal call emits the full observation (no diff) even with a same-screen baseline", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      serverConfig.setActionsNoObserveEnabled(false);
      const { store, map } = makeStore();
      // Seed a same-screen baseline so a non-internal call WOULD diff.
      map.set("s1", sameScreenObserve());

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, internal: true }
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined(); // full observation, not a diff
      expect(obsSc.viewHierarchy).toBeDefined();
      expect((finalized.structuredContent as any).observationDiff).toBeUndefined();
      // A future internal consumer can still read the hierarchy off the envelope.
      expect(obsSc.viewHierarchy.hierarchy.node["resource-id"]).toBe("com.example:id/root");
    });

    test("EC2.1: internal call leaves the diff baseline untouched", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      serverConfig.setActionsNoObserveEnabled(false);
      const { store, map } = makeStore();
      map.set("s1", sameScreenObserve());
      const before = map.get("s1");

      finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, internal: true }
      );

      // Internal calls neither read a diff nor advance the agent-facing baseline.
      expect(map.get("s1")).toBe(before);
    });

    test("EC2.2: internal call preserves the observation even with --actions-no-observe on", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      serverConfig.setActionsDiffObserveEnabled(false);

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", internal: true }
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc).toBeDefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expect((finalized.structuredContent as any).observationDiff).toBeUndefined();
    });

    test("EC2.2: internal call still sanitizes the observation (view-id dedup applies)", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        { name: "tapOn", sessionUuid: "s1", internal: true }
      );
      const node = (finalized.structuredContent as any).observation.viewHierarchy.hierarchy.node;
      // Sanitization (issue #2758) is independent of the diff guard.
      expect(node["view-id"]).toBeUndefined();
      expect(node.clickable).toBeUndefined();
    });

    test("non-internal same-screen call still diffs (guard is opt-in)", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      serverConfig.setActionsNoObserveEnabled(false);
      const { store, map } = makeStore();
      map.set("s1", sameScreenObserve());

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, internal: false }
      );

      expect((finalized.structuredContent as any).observation.isDiff).toBe(true);
    });
  });
});
