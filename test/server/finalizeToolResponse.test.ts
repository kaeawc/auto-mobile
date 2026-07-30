import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_OBSERVATION_INLINE_MAX_BYTES, finalizeToolResponse } from "../../src/server/finalizeToolResponse";
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

class FakeObservationArtifactWriter {
  writes: Array<{ tool: string; payload: string; data: unknown }> = [];
  throwOnWrite: Error | undefined;

  writeJsonArtifact(input: { tool: string; payload: string; data: unknown }): unknown {
    if (this.throwOnWrite) {
      throw this.throwOnWrite;
    }
    this.writes.push(input);
    return {
      artifact: {
        path: `/tmp/auto-mobile/${input.tool}-${this.writes.length}.json`,
        format: "json",
        payload: input.payload,
        bytes: 123,
        tool: input.tool,
      },
    };
  }
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
      key = "bundle=com.apple.reminders|focus=Title",
      nextKey = key
    ): StructuredToolResponse<{ success: boolean; observation: ObserveResult }> {
      const { store } = makeStore();
      const baseline = iosScreenObserve(key, "low");
      finalizeToolResponse(
        createStructuredToolResponse(baseline),
        { name: "observe", sessionUuid: "s1", baselineStore: store }
      );

      return finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: checkedIosScreenObserve(nextKey, "low") }),
        {
          name,
          args: actionArgs,
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

    test("action policy: inputText emits full when uncertain identity key changes", () => {
      const finalized = finalizeChangedLowConfidenceAction(
        "inputText",
        { text: "hello" },
        "bundle=com.apple.reminders|focus=Title",
        "bundle=com.apple.reminders|focus=Search"
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("action policy: swipeOn emits full when uncertain identity key changes", () => {
      const finalized = finalizeChangedLowConfidenceAction(
        "swipeOn",
        { direction: "up" },
        "bundle=com.apple.reminders|list=Inbox",
        "bundle=com.apple.reminders|list=Search"
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("action policy: finalizer derives pressButton policy from args", () => {
      const volume = finalizeChangedLowConfidenceAction("pressButton", { button: "volume_up" });
      expect((volume.structuredContent as any).observation.isDiff).toBe(true);
      expectObservationDiff(volume, { mode: "diff", reason: "diff_emitted" });

      const back = finalizeChangedLowConfidenceAction("pressButton", { button: "back" });
      expect((back.structuredContent as any).observation.isDiff).toBeUndefined();
      expect((back.structuredContent as any).observation.viewHierarchy).toBeDefined();
      expectObservationDiff(back, { mode: "full", reason: "screen_changed" });
    });

    test("action policy: submit-style IME actions are navigation-prone", () => {
      const inputSearch = finalizeChangedLowConfidenceAction("inputText", { text: "query", imeAction: "search" });
      expect((inputSearch.structuredContent as any).observation.isDiff).toBeUndefined();
      expect((inputSearch.structuredContent as any).observation.viewHierarchy).toBeDefined();
      expectObservationDiff(inputSearch, { mode: "full", reason: "screen_changed" });

      const imeGo = finalizeChangedLowConfidenceAction("imeAction", { action: "go" });
      expect((imeGo.structuredContent as any).observation.isDiff).toBeUndefined();
      expect((imeGo.structuredContent as any).observation.viewHierarchy).toBeDefined();
      expectObservationDiff(imeGo, { mode: "full", reason: "screen_changed" });
    });

    test("action policy: focus-traversal IME actions remain in-place", () => {
      const inputNext = finalizeChangedLowConfidenceAction("inputText", { text: "value", imeAction: "next" });
      expect((inputNext.structuredContent as any).observation.isDiff).toBe(true);
      expectObservationDiff(inputNext, { mode: "diff", reason: "diff_emitted" });

      const imePrevious = finalizeChangedLowConfidenceAction("imeAction", { action: "previous" });
      expect((imePrevious.structuredContent as any).observation.isDiff).toBe(true);
      expectObservationDiff(imePrevious, { mode: "diff", reason: "diff_emitted" });
    });

    // One row per documented action so a single failing case is attributable
    // (#4183 item 17). %j renders the args object into each generated test name.
    const navigationProneActions: Array<[string, Record<string, unknown>]> = [
      ["tapOn", { action: "tap" }],
      ["tapAny", { action: "tap" }],
      ["homeScreen", {}],
      ["recentApps", {}],
      ["openLink", { url: "https://example.com" }],
      ["pressButton", { button: "back" }],
      ["pressButton", { button: "home" }],
      ["pressButton", { button: "recent" }],
      ["pressButton", { button: "power" }],
      ["inputText", { text: "query", imeAction: "done" }],
      ["inputText", { text: "query", imeAction: "go" }],
      ["inputText", { text: "query", imeAction: "search" }],
      ["inputText", { text: "query", imeAction: "send" }],
      ["imeAction", { action: "done" }],
      ["imeAction", { action: "go" }],
      ["imeAction", { action: "search" }],
      ["imeAction", { action: "send" }],
    ];

    test.each(navigationProneActions)(
      "action policy: %s %j emits full on uncertain identity",
      (name, args) => {
        const finalized = finalizeChangedLowConfidenceAction(name, args);
        expect((finalized.structuredContent as any).observation.isDiff).toBeUndefined();
        expect((finalized.structuredContent as any).observation.viewHierarchy).toBeDefined();
        expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
      }
    );

    const inPlaceAndScrollActions: Array<[string, Record<string, unknown>]> = [
      ["inputText", { text: "hello" }],
      ["inputText", { text: "hello", imeAction: "next" }],
      ["inputText", { text: "hello", imeAction: "previous" }],
      ["clearText", {}],
      ["selectAllText", {}],
      ["imeAction", { action: "next" }],
      ["imeAction", { action: "previous" }],
      ["keyboard", { action: "open" }],
      ["clipboard", { action: "paste" }],
      ["pressButton", { button: "menu" }],
      ["pressButton", { button: "volume_up" }],
      ["pressButton", { button: "volume_down" }],
      ["swipeOn", { direction: "up" }],
      ["dragAndDrop", {}],
    ];

    test.each(inPlaceAndScrollActions)(
      "action policy: %s %j diffs on stable uncertain identity",
      (name, args) => {
        const finalized = finalizeChangedLowConfidenceAction(name, args);
        expect((finalized.structuredContent as any).observation.isDiff).toBe(true);
        expectObservationDiff(finalized, { mode: "diff", reason: "diff_emitted" });
      }
    );

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

  describe("observation artifact mode (#3480)", () => {
    let originalDiff: boolean;
    let originalNoObserve: boolean;

    function sameScreenObserve(): ObserveResult {
      return {
        ...makeObserveResultWithBounds(),
        activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.example",
          hierarchy: {
            node: {
              "resource-id": "com.example:id/root",
              "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
              "node": [{ "resource-id": "com.example:id/child", "text": "Hello" } as any],
            } as any,
          },
        },
      } as ObserveResult;
    }

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

    beforeEach(() => {
      originalDiff = serverConfig.isActionsDiffObserveEnabled();
      originalNoObserve = serverConfig.isActionsNoObserveEnabled();
      serverConfig.setActionsDiffObserveEnabled(false);
      serverConfig.setActionsNoObserveEnabled(false);
    });

    afterEach(() => {
      serverConfig.setActionsDiffObserveEnabled(originalDiff);
      serverConfig.setActionsNoObserveEnabled(originalNoObserve);
    });

    test("observe returns artifact metadata instead of an inline ObserveResult", () => {
      const writer = new FakeObservationArtifactWriter();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(makeObserveResult()),
        { name: "observe", sessionUuid: "s1", artifactWriter: writer } as any
      );

      expect(finalized.structuredContent).toEqual({
        artifact: {
          path: "/tmp/auto-mobile/observe-1.json",
          format: "json",
          payload: "ObserveResult",
          bytes: 123,
          tool: "observe",
        },
      });
      expect((finalized.structuredContent as any).viewHierarchy).toBeUndefined();
      expect(writer.writes).toHaveLength(1);
      expect((writer.writes[0].data as any).viewHierarchy.hierarchy.node["view-id"]).toBeUndefined();
      expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    });

    test("artifacted observe keeps wait status inline", () => {
      const writer = new FakeObservationArtifactWriter();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({
          ...makeObserveResult(),
          matched: false,
          timedOut: true,
          polls: 3,
          waitMs: 250,
        }),
        { name: "observe", sessionUuid: "s1", artifactWriter: writer } as any
      );

      expect(finalized.structuredContent).toMatchObject({
        artifact: expect.any(Object),
        matched: false,
        timedOut: true,
        polls: 3,
        waitMs: 250,
      });
      expect(writer.writes[0].data).toMatchObject({ matched: false, timedOut: true });
    });

    test("action observation fields are replaced with artifact metadata", () => {
      const writer = new FakeObservationArtifactWriter();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        { name: "tapOn", sessionUuid: "s1", artifactWriter: writer } as any
      );

      expect((finalized.structuredContent as any).success).toBe(true);
      expect((finalized.structuredContent as any).observation).toEqual({
        artifact: {
          path: "/tmp/auto-mobile/tapOn-1.json",
          format: "json",
          payload: "ObserveResult",
          bytes: 123,
          tool: "tapOn",
        },
      });
      expect((finalized.structuredContent as any).observation.viewHierarchy).toBeUndefined();
      expect((writer.writes[0].data as any).viewHierarchy.hierarchy.node["view-id"]).toBeUndefined();
      expect(JSON.parse(finalized.content[0].text)).toEqual(finalized.structuredContent);
    });

    test("artifact writer receives the compacted diff after existing output transforms", () => {
      serverConfig.setObserveResultCompactEnabled(true);
      serverConfig.setActionsDiffObserveEnabled(true);
      const { store } = makeStore();
      finalizeToolResponse(
        createStructuredToolResponse(sameScreenObserve()),
        { name: "observe", sessionUuid: "s1", baselineStore: store }
      );

      const next = sameScreenObserve();
      (next.viewHierarchy!.hierarchy.node as any).node = [
        { "resource-id": "com.example:id/added", "bounds": { left: 5, top: 6, right: 7, bottom: 8 } },
      ];
      const writer = new FakeObservationArtifactWriter();

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, artifactWriter: writer } as any
      );

      expect((writer.writes[0].data as any).isDiff).toBe(true);
      expect(writer.writes[0].payload).toBe("ObserveDiff");
      expect((writer.writes[0].data as any).added[0].attributes.bounds).toEqual([5, 6, 7, 8]);
      expect((finalized.structuredContent as any).observation.artifact.path).toBe("/tmp/auto-mobile/tapOn-1.json");
      expect((finalized.structuredContent as any).observation.artifact.payload).toBe("ObserveDiff");
      expect((finalized.structuredContent as any).observationDiff).toMatchObject({
        mode: "diff",
        reason: "diff_emitted",
      });
      expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    });

    test("internal calls receive full observations and do not write artifacts", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      const writer = new FakeObservationArtifactWriter();

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        { name: "tapOn", sessionUuid: "s1", internal: true, artifactWriter: writer } as any
      );

      expect(writer.writes).toHaveLength(0);
      expect((finalized.structuredContent as any).observation.viewHierarchy).toBeDefined();
      expect((finalized.structuredContent as any).observation.artifact).toBeUndefined();
      expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    });

    test("artifact write failures are loud and do not produce inline fallback output", () => {
      const writer = new FakeObservationArtifactWriter();
      writer.throwOnWrite = new Error("artifact disk is full");
      const response = createStructuredToolResponse(makeObserveResult());

      expect(() => finalizeToolResponse(
        response,
        { name: "observe", sessionUuid: "s1", artifactWriter: writer } as any
      )).toThrow("artifact disk is full");
      expect((response.structuredContent as any).viewHierarchy).toBeDefined();
      expect((response.structuredContent as any).artifact).toBeUndefined();
    });

    test("artifact write failures do not advance the diff baseline", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      const { store, map } = makeStore();
      finalizeToolResponse(
        createStructuredToolResponse(sameScreenObserve()),
        { name: "observe", sessionUuid: "s1", baselineStore: store }
      );
      const renderedBaseline = map.get("s1");
      const next = sameScreenObserve();
      (next.viewHierarchy!.hierarchy.node as any).node = [
        { "resource-id": "com.example:id/not-rendered", "bounds": { left: 1, top: 2, right: 3, bottom: 4 } },
      ];
      const writer = new FakeObservationArtifactWriter();
      writer.throwOnWrite = new Error("artifact disk is full");

      expect(() => finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, artifactWriter: writer } as any
      )).toThrow("artifact disk is full");
      expect(map.get("s1")).toBe(renderedBaseline);
    });

    describe("oversized artifact-mode 64KB boundary (#4183 item 4)", () => {
      // In "oversized" mode only a served payload whose serialized size exceeds
      // the 64KB inline ceiling is routed to the artifact writer; anything at or
      // under the threshold stays inline. These tests pin the exact 65536-byte
      // boundary (shouldArtifactObservationPayload uses a strict `>` comparison).
      //
      // The payloads below are sized against the LITERAL 65536/65537 byte counts,
      // not the DEFAULT_OBSERVATION_INLINE_MAX_BYTES symbol, so a change to the
      // production threshold breaks these tests instead of silently sliding with
      // it. This canary makes the literal↔constant coupling explicit: if it
      // fails, the boundary moved and the literals below must be re-derived.
      const INLINE_MAX_BYTES = 65536;
      const FIRST_ARTIFACT_BYTES = 65537;
      test("the production inline ceiling is still 65536 bytes", () => {
        expect(DEFAULT_OBSERVATION_INLINE_MAX_BYTES).toBe(INLINE_MAX_BYTES);
      });

      const oversizedCtx = (writer: FakeObservationArtifactWriter) =>
        ({ name: "tapOn", artifactMode: "oversized", artifactWriter: writer } as any);

      // Build a tapOn response padded so the object measured by the size gate
      // serializes to exactly `targetBytes`. The `pad` field is copied verbatim
      // into the served payload (only `observation` is transformed), so each ASCII
      // char is exactly one UTF-8 byte. A zero-pad probe stays inline — far under
      // 64KB — so its returned structuredContent IS the object the gate measures,
      // giving the base size to calibrate against.
      function tapResponseOfSize(targetBytes: number): StructuredToolResponse {
        const build = (pad: string) =>
          createStructuredToolResponse({ success: true, pad, observation: makeObserveResult() });
        const probe = finalizeToolResponse(build(""), oversizedCtx(new FakeObservationArtifactWriter()));
        const baseBytes = Buffer.byteLength(stringifyToolResponse(probe.structuredContent), "utf8");
        return build("x".repeat(targetBytes - baseBytes));
      }

      test("a served payload exactly at 65536 bytes stays inline", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          tapResponseOfSize(INLINE_MAX_BYTES),
          oversizedCtx(writer)
        );

        expect(Buffer.byteLength(stringifyToolResponse(finalized.structuredContent), "utf8")).toBe(65536);
        expect(writer.writes).toHaveLength(0);
        expect((finalized.structuredContent as any).observation.viewHierarchy).toBeDefined();
        expect((finalized.structuredContent as any).observation.artifact).toBeUndefined();
      });

      test("a served payload one byte over 65536 is routed to the artifact writer", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          tapResponseOfSize(FIRST_ARTIFACT_BYTES),
          oversizedCtx(writer)
        );

        expect(writer.writes).toHaveLength(1);
        expect((finalized.structuredContent as any).observation).toEqual({
          artifact: {
            path: "/tmp/auto-mobile/tapOn-1.json",
            format: "json",
            payload: "ObserveResult",
            bytes: 123,
            tool: "tapOn",
          },
        });
        expect((finalized.structuredContent as any).observation.viewHierarchy).toBeUndefined();
      });
    });
  });

  describe("non-observation artifact mode (#3481)", () => {
    test("executePlan artifacts large failure/debug observation subtrees and keeps summaries inline", () => {
      const writer = new FakeObservationArtifactWriter();
      const failureObservation = {
        capturedAtMs: 123,
        activeWindow: { appId: "com.example" },
        viewHierarchy: { hierarchy: { node: { "resource-id": "root" } } },
        rawViewHierarchy: "<hierarchy><node text=\"large\" /></hierarchy>",
        visibleTextsSample: ["Submit"],
        resourceIdsSample: ["com.example:id/submit"],
      };
      const stepObservation = {
        capturedAtMs: 456,
        viewHierarchy: { hierarchy: { node: { "resource-id": "step-root" } } },
        visibleTextsSample: ["Step"],
      };
      const debugFailureObservation = {
        capturedAtMs: 789,
        viewHierarchy: { hierarchy: { node: { "resource-id": "debug-failure-root" } } },
        rawViewHierarchy: "<hierarchy><node text=\"debug failure\" /></hierarchy>",
        visibleTextsSample: ["Debug failure"],
      };
      const payload = {
        success: false,
        executedSteps: 1,
        totalSteps: 2,
        failedStep: {
          stepIndex: 1,
          tool: "tapOn",
          error: "Button missing",
          failureObservation,
        },
        debug: {
          executionTimeMs: 50,
          steps: [
            {
              step: "1: observe",
              status: "completed",
              durationMs: 10,
              details: { stepObservation, failureObservation: debugFailureObservation },
            },
          ],
        },
      };

      const finalized = finalizeToolResponse(
        createStructuredToolResponse(payload),
        { name: "executePlan", artifactWriter: writer } as any
      );

      const failedObservation = (finalized.structuredContent as any).failedStep.failureObservation;
      expect(failedObservation.capturedAtMs).toBe(123);
      expect(failedObservation.visibleTextsSample).toEqual(["Submit"]);
      expect(failedObservation.resourceIdsSample).toEqual(["com.example:id/submit"]);
      expect(failedObservation.viewHierarchy).toEqual({
        artifact: {
          path: "/tmp/auto-mobile/executePlan-1.json",
          format: "json",
          payload: "ExecutePlanFailureObservationViewHierarchy",
          bytes: 123,
          tool: "executePlan",
        },
      });
      expect(failedObservation.rawViewHierarchy).toEqual({
        artifact: {
          path: "/tmp/auto-mobile/executePlan-2.json",
          format: "json",
          payload: "ExecutePlanFailureObservationRawViewHierarchy",
          bytes: 123,
          tool: "executePlan",
        },
      });

      const finalizedStepObservation = (finalized.structuredContent as any).debug.steps[0].details.stepObservation;
      expect(finalizedStepObservation.visibleTextsSample).toEqual(["Step"]);
      expect(finalizedStepObservation.viewHierarchy.artifact.payload).toBe("ExecutePlanDebugStepObservationViewHierarchy");
      const finalizedDebugFailureObservation = (finalized.structuredContent as any).debug.steps[0].details.failureObservation;
      expect(finalizedDebugFailureObservation.visibleTextsSample).toEqual(["Debug failure"]);
      expect(finalizedDebugFailureObservation.viewHierarchy.artifact.payload).toBe("ExecutePlanDebugFailureObservationViewHierarchy");
      expect(finalizedDebugFailureObservation.rawViewHierarchy.artifact.payload).toBe("ExecutePlanDebugFailureObservationRawViewHierarchy");
      expect(writer.writes.map(write => write.payload)).toEqual([
        "ExecutePlanFailureObservationViewHierarchy",
        "ExecutePlanFailureObservationRawViewHierarchy",
        "ExecutePlanDebugStepObservationViewHierarchy",
        "ExecutePlanDebugFailureObservationViewHierarchy",
        "ExecutePlanDebugFailureObservationRawViewHierarchy",
      ]);
      expect(writer.writes[0].data).toEqual(failureObservation.viewHierarchy);
      expect(writer.writes[1].data).toBe(failureObservation.rawViewHierarchy);
      expect(writer.writes[2].data).toEqual(stepObservation.viewHierarchy);
      expect(writer.writes[3].data).toEqual(debugFailureObservation.viewHierarchy);
      expect(writer.writes[4].data).toBe(debugFailureObservation.rawViewHierarchy);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    });

    test("bugReport artifacts raw report details and keeps status summaries inline", () => {
      const writer = new FakeObservationArtifactWriter();
      const payload = {
        reportId: "bug-1",
        timestamp: 123,
        device: { deviceId: "emulator-5554", platform: "android" },
        screenState: { currentPackage: "com.example" },
        viewHierarchy: {
          rawXml: "<hierarchy><node text=\"large\" /></hierarchy>",
          elementCount: 42,
          filteredNodeCount: 3,
          clickableElements: [{ text: "Submit", bounds: { left: 0, top: 0, right: 1, bottom: 1 } }],
        },
        logcat: {
          errors: ["E/Example: one", "E/Example: two"],
          warnings: ["W/Example: warn"],
          appLogs: ["I/Example: app"],
        },
        windowState: {
          focusedWindow: "com.example/.Main",
          windows: ["Window #1", "Window #2"],
        },
        savedTo: "/tmp/bug-report.json",
        errors: [],
      };

      const finalized = finalizeToolResponse(
        createStructuredToolResponse(payload),
        { name: "bugReport", artifactWriter: writer } as any
      );

      const report = finalized.structuredContent as any;
      expect(report.reportId).toBe("bug-1");
      expect(report.device.deviceId).toBe("emulator-5554");
      expect(report.viewHierarchy.elementCount).toBe(42);
      expect(report.viewHierarchy.clickableElements).toHaveLength(1);
      expect(report.viewHierarchy.rawXml.artifact.payload).toBe("BugReportViewHierarchyRawXml");
      expect(report.logcatSummary).toEqual({ errorCount: 2, warningCount: 1, appLogCount: 1 });
      expect(report.logcat).toEqual({
        artifact: {
          path: "/tmp/auto-mobile/bugReport-2.json",
          format: "json",
          payload: "BugReportLogcat",
          bytes: 123,
          tool: "bugReport",
        },
      });
      expect(report.windowState.focusedWindow).toBe("com.example/.Main");
      expect(report.windowState.windows.artifact.payload).toBe("BugReportWindowList");
      expect(writer.writes.map(write => write.payload)).toEqual([
        "BugReportViewHierarchyRawXml",
        "BugReportLogcat",
        "BugReportWindowList",
      ]);
      expect(writer.writes[0].data).toBe(payload.viewHierarchy.rawXml);
      expect(writer.writes[1].data).toEqual(payload.logcat);
      expect(writer.writes[2].data).toEqual(payload.windowState.windows);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    });

    test("getNetworkGraph artifacts aggregate graph and keeps host count inline", () => {
      const writer = new FakeObservationArtifactWriter();
      const payload = {
        graph: [
          {
            scheme: "https",
            host: "api.example.com",
            paths: {
              v1: {
                paths: {
                  "users[GET]": { method: "GET", success: 10, errors: 1, p50: 100, p95: 200 },
                },
              },
            },
          },
        ],
      };

      const finalized = finalizeToolResponse(
        createStructuredToolResponse(payload),
        { name: "getNetworkGraph", artifactWriter: writer } as any
      );

      expect(finalized.structuredContent).toEqual({
        graph: {
          artifact: {
            path: "/tmp/auto-mobile/getNetworkGraph-1.json",
            format: "json",
            payload: "NetworkGraph",
            bytes: 123,
            tool: "getNetworkGraph",
          },
        },
        graphSummary: { hostCount: 1 },
      });
      expect(writer.writes).toEqual([
        { tool: "getNetworkGraph", payload: "NetworkGraph", data: payload.graph },
      ]);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    });

    test("internal executePlan calls do not artifact non-observation payloads", () => {
      const writer = new FakeObservationArtifactWriter();
      const payload = {
        success: false,
        executedSteps: 1,
        totalSteps: 2,
        failedStep: {
          stepIndex: 1,
          tool: "tapOn",
          error: "Button missing",
          failureObservation: {
            capturedAtMs: 123,
            viewHierarchy: { hierarchy: { node: { text: "keep inline" } } },
          },
        },
      };

      const finalized = finalizeToolResponse(
        createStructuredToolResponse(payload),
        { name: "executePlan", internal: true, artifactWriter: writer } as any
      );

      expect(writer.writes).toHaveLength(0);
      expect(finalized.structuredContent).toEqual(payload);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(payload));
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

  describe("skeleton projection (issue #4388)", () => {
    let originalSkeleton: boolean;

    beforeEach(() => {
      originalSkeleton = serverConfig.isObserveResultProjectSkeletonEnabled();
      serverConfig.setObserveResultProjectSkeletonEnabled(false);
    });

    afterEach(() => {
      serverConfig.setObserveResultProjectSkeletonEnabled(originalSkeleton);
    });

    /** An observe result whose elements carry bounds so the skeleton is non-empty. */
    function observeWithActionableElements(): ObserveResult {
      const obs = makeObserveResult();
      obs.elements = {
        clickable: [
          {
            "bounds": { left: 0, top: 0, right: 100, bottom: 50 },
            "resource-id": "com.example:id/btn",
            "text": "Submit",
            "clickable": "true",
          } as any,
        ],
        scrollable: [],
        text: [],
        media: [],
      };
      return obs;
    }

    test("flag off + no project arg: default behavior unchanged (full tree, no skeleton)", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe" }
      );
      const sc = finalized.structuredContent as ObserveResult;
      expect(sc.skeleton).toBeUndefined();
      expect(sc.viewHierarchy?.hierarchy).toBeDefined();
      expect(sc.elements).toBeDefined();
    });

    test("flag on: observe returns a skeleton and omits viewHierarchy + elements", () => {
      serverConfig.setObserveResultProjectSkeletonEnabled(true);
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe" }
      );
      const sc = finalized.structuredContent as ObserveResult;
      expect(Array.isArray(sc.skeleton)).toBe(true);
      expect(sc.skeleton!.length).toBeGreaterThan(0);
      expect(sc.viewHierarchy).toBeUndefined();
      expect(sc.elements).toBeUndefined();
      // text mirror agrees with structuredContent.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.skeleton.length).toBe(sc.skeleton!.length);
    });

    test("per-call project:'skeleton' arg projects even with the flag off", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe", args: { project: "skeleton" } }
      );
      const sc = finalized.structuredContent as ObserveResult;
      expect(sc.skeleton).toBeDefined();
      expect(sc.viewHierarchy).toBeUndefined();
    });

    test("explicit project:'full' overrides the flag (full tree returned)", () => {
      serverConfig.setObserveResultProjectSkeletonEnabled(true);
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe", args: { project: "full" } }
      );
      const sc = finalized.structuredContent as ObserveResult;
      expect(sc.skeleton).toBeUndefined();
      expect(sc.viewHierarchy?.hierarchy).toBeDefined();
    });

    test("raw:true forces the full tree even when the flag is on", () => {
      serverConfig.setObserveResultProjectSkeletonEnabled(true);
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe", args: { raw: true } }
      );
      const sc = finalized.structuredContent as ObserveResult;
      expect(sc.skeleton).toBeUndefined();
      expect(sc.viewHierarchy?.hierarchy).toBeDefined();
    });

    test("embedded action observations are never skeletonized (scoped to observe)", () => {
      serverConfig.setObserveResultProjectSkeletonEnabled(true);
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: observeWithActionableElements() }),
        { name: "tapOn", sessionUuid: "s1" }
      );
      const obsSc = (finalized.structuredContent as any).observation as ObserveResult;
      expect(obsSc.skeleton).toBeUndefined();
      expect(obsSc.viewHierarchy?.hierarchy).toBeDefined();
    });
  });
});

/**
 * Observe scope experiments (issue #4344). The per-call `scope` request arrives on
 * the observe tool args; a server flag gates each dimension. Scoping is applied to
 * the agent-facing payload only — it must leave the diff baseline (the full
 * sanitized tree) intact and never touch internal tool-to-tool calls.
 */
describe("finalizeToolResponse observe scope experiments (#4344)", () => {
  let originalSkeleton: boolean;

  beforeEach(() => {
    originalSkeleton = serverConfig.isObserveResultProjectSkeletonEnabled();
    serverConfig.setObserveResultProjectSkeletonEnabled(false);
    serverConfig.setObserveFocusScopeEnabled(false);
    serverConfig.setObserveOverviewEnabled(false);
    serverConfig.setObserveRegionEnabled(false);
    serverConfig.setActionsDiffObserveEnabled(false);
  });

  afterEach(() => {
    serverConfig.setObserveResultProjectSkeletonEnabled(originalSkeleton);
    serverConfig.setObserveFocusScopeEnabled(false);
    serverConfig.setObserveOverviewEnabled(false);
    serverConfig.setObserveRegionEnabled(false);
    serverConfig.setActionsDiffObserveEnabled(false);
  });

  function chromeObserve(): ObserveResult {
    return {
      updatedAt: 1,
      screenSize: { width: 1000, height: 2000 },
      systemInsets: { top: 100, bottom: 100, left: 0, right: 0 },
      activeWindow: { appId: "com.example.app" } as ObserveResult["activeWindow"],
      viewHierarchy: {
        packageName: "com.example.app",
        hierarchy: {
          node: {
            "class": "Root",
            "bounds": { left: 0, top: 0, right: 1000, bottom: 2000 },
            // Package-qualified resource-ids are the app-vs-chrome signal that
            // survives cleanNodeProperties (per-node `package` does not).
            "node": [
              { "resource-id": "com.android.systemui:id/status_bar", "bounds": { left: 0, top: 0, right: 1000, bottom: 100 } },
              { "resource-id": "com.example.app:id/content", "text": "Hi", "bounds": { left: 0, top: 100, right: 1000, bottom: 1900 } },
            ],
          } as any,
        },
      },
    } as ObserveResult;
  }

  test("no scope flags: reports requested dimensions gated off", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { scope: { focus: true, region: true, overview: true } },
    });
    const out = finalized.structuredContent as ObserveResult;
    expect(out.observeScope).toMatchObject({
      applied: [],
      gatedOff: ["focus", "region", "overview"],
    });
    expect(out.observeScope!.nodesAfter).toBe(out.observeScope!.nodesBefore);
  });

  test("reports a disabled requested dimension alongside enabled scope transforms", () => {
    serverConfig.setObserveFocusScopeEnabled(true);
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { scope: { focus: true, region: true } },
    });
    expect((finalized.structuredContent as ObserveResult).observeScope).toMatchObject({
      applied: ["focus"],
      gatedOff: ["region"],
    });
  });

  test("flag on but no scope in the call: payload is untouched", () => {
    serverConfig.setObserveFocusScopeEnabled(true);
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), { name: "observe", args: {} });
    expect((finalized.structuredContent as ObserveResult).observeScope).toBeUndefined();
  });

  test("scope.focus in the call (flag on) scopes the payload and records observeScope", () => {
    serverConfig.setObserveFocusScopeEnabled(true);
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { scope: { focus: true } },
    });
    const out = finalized.structuredContent as ObserveResult;
    expect(out.observeScope?.applied).toContain("focus");
    expect(out.observeScope!.nodesAfter).toBeLessThan(out.observeScope!.nodesBefore);
    // text mirror agrees with structuredContent.
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("explicit skeleton projection preserves all-gated scope metadata without a scope transform", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: {
        project: "skeleton",
        scope: { focus: true, region: true, overview: true },
      },
    });

    const out = finalized.structuredContent as ObserveResult;
    expect(out.skeleton).toEqual([]);
    expect(out.viewHierarchy).toBeUndefined();
    expect(out.elements).toBeUndefined();
    expect(out.observeScope).toMatchObject({
      applied: [],
      gatedOff: ["focus", "region", "overview"],
    });
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("flag-enabled skeleton preserves gated metadata without applying enabled scope transforms", () => {
    serverConfig.setObserveResultProjectSkeletonEnabled(true);
    serverConfig.setObserveFocusScopeEnabled(true);
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { scope: { focus: true, region: true } },
    });

    const out = finalized.structuredContent as ObserveResult;
    expect(out.skeleton).toEqual([]);
    expect(out.viewHierarchy).toBeUndefined();
    expect(out.observeScope).toMatchObject({
      applied: [],
      gatedOff: ["region"],
    });
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("scope.region box in the call (flag on) crops to the normalized rectangle", () => {
    serverConfig.setObserveRegionEnabled(true);
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { scope: { region: { x1: 0, y1: 0, x2: 1, y2: 0.5 } } }, // top half only
    });
    const out = finalized.structuredContent as ObserveResult;
    expect(out.observeScope?.regionPx).toEqual({ left: 0, top: 0, right: 1000, bottom: 1000 });
  });

  test("internal observe calls are never scoped", () => {
    serverConfig.setObserveFocusScopeEnabled(true);
    const finalized = finalizeToolResponse(
      createStructuredToolResponse(chromeObserve()),
      { name: "observe", internal: true, args: { scope: { focus: true } } }
    );
    expect((finalized.structuredContent as ObserveResult).observeScope).toBeUndefined();
  });

  test("diff baseline is the full sanitized tree, not the scoped copy", () => {
    serverConfig.setObserveFocusScopeEnabled(true);
    serverConfig.setActionsDiffObserveEnabled(true);
    const map = new Map<string, ObserveResult>();
    const store = { get: (u: string) => map.get(u), set: (u: string, o: ObserveResult) => { map.set(u, o); } };

    finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      sessionUuid: "s1",
      baselineStore: store,
      args: { scope: { focus: true } },
    });

    // Baseline retains the system-chrome node the served payload dropped.
    const baseline = map.get("s1")!;
    expect(baseline.observeScope).toBeUndefined();
    const ids: string[] = [];
    const walk = (n: any): void => {
      if (n["resource-id"]) { ids.push(n["resource-id"]); }
      for (const c of (n.node ?? [])) { walk(c); }
    };
    walk(baseline.viewHierarchy!.hierarchy.node);
    expect(ids).toContain("com.android.systemui:id/status_bar");
  });
});
