import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_OBSERVATION_INLINE_MAX_BYTES,
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
          text: "", // empty → dropped
          clickable: "false", // default-false boolean → dropped
          "content-desc": "keep-me",
          node: [
            {
              "resource-id": "com.example:id/child",
              text: "Hello",
              focusable: "false", // dropped
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
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          node: [
            {
              "resource-id": "com.example:id/child",
              bounds: { left: 10, top: 20, right: 30, bottom: 40 },
            } as any,
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
  // Bounds compaction and skeleton projection are now unconditional defaults, and
  // `elements` are dropped by default (opt back in via
  // `--observe-result-include-elements`). Only the include-elements accessor
  // survives; save/restore it so a test toggling it can't leak into the singleton.
  let originalIncludeElements: boolean;

  beforeEach(() => {
    originalIncludeElements = serverConfig.isObserveResultIncludeElementsEnabled();
    serverConfig.setObserveResultIncludeElementsEnabled(false);
  });

  afterEach(() => {
    serverConfig.setObserveResultIncludeElementsEnabled(originalIncludeElements);
  });

  test("EC1: observe response is sanitized in both structuredContent and text", () => {
    const obs = makeObserveResult();
    const response = createStructuredToolResponse(obs);

    // project:"full" opts out of the now-default skeleton so this stays a test of
    // hierarchy trimming.
    const finalized = finalizeToolResponse(response, {
      name: "observe",
      sessionUuid: "s1",
      args: { project: "full" },
    });

    const rootSc = (finalized.structuredContent as ObserveResult).viewHierarchy!.hierarchy
      .node as any;
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

    // project:"full" keeps the raw hierarchy under test; the skeleton default is
    // covered separately in "action-tool skeleton default (#5872)".
    const finalized = finalizeToolResponse(response, {
      name: "tapOn",
      sessionUuid: "s1",
      args: { project: "full" },
    });

    const obsSc = (finalized.structuredContent as any).observation as ObserveResult;
    const rootSc = obsSc.viewHierarchy!.hierarchy.node as any;
    expect(rootSc["view-id"]).toBeUndefined();
    expect(rootSc.clickable).toBeUndefined();
    expect((finalized.structuredContent as any).success).toBe(true);

    const parsed = JSON.parse(finalized.content[0].text);
    expect(parsed.observation.viewHierarchy.hierarchy.node["view-id"]).toBeUndefined();
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  // Action tools default their embedded observation to the compact skeleton
  // (issue #5872): the same response-shape control `observe` already has, so a
  // client no longer pays the full raw hierarchy on every tapOn/inputText/launchApp.
  describe("action-tool skeleton default (#5872)", () => {
    test("an action observation defaults to the compact skeleton (no viewHierarchy)", () => {
      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, { name: "tapOn" });
      const observation = (finalized.structuredContent as any).observation;
      expect(Array.isArray(observation.skeleton)).toBe(true);
      expect(observation.viewHierarchy).toBeUndefined();
      expect(observation.elements).toBeUndefined();
      // The compact form is under the SAME `skeleton` key `observe` uses (#5872 AC2).
      const parsed = JSON.parse(finalized.content[0].text);
      expect(Array.isArray(parsed.observation.skeleton)).toBe(true);
      expect(parsed.observation.viewHierarchy).toBeUndefined();
      expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    });

    test('project:"full" opts an action observation back into the raw viewHierarchy', () => {
      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, {
        name: "tapOn",
        args: { project: "full" },
      });
      const observation = (finalized.structuredContent as any).observation;
      expect(observation.viewHierarchy).toBeDefined();
      expect(observation.skeleton).toBeUndefined();
    });

    test("raw:true opts an action observation back into the raw viewHierarchy", () => {
      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, {
        name: "inputText",
        args: { raw: true },
      });
      const observation = (finalized.structuredContent as any).observation;
      expect(observation.viewHierarchy).toBeDefined();
      expect(observation.skeleton).toBeUndefined();
    });

    test("launchApp's observation also defaults to the compact skeleton", () => {
      const response = createStructuredToolResponse({
        success: true,
        packageName: "com.example",
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, { name: "launchApp" });
      const observation = (finalized.structuredContent as any).observation;
      expect(Array.isArray(observation.skeleton)).toBe(true);
      expect(observation.viewHierarchy).toBeUndefined();
    });

    test("internal tool-to-tool calls keep the full viewHierarchy for in-process consumers", () => {
      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, { name: "tapOn", internal: true });
      const observation = (finalized.structuredContent as any).observation;
      expect(observation.viewHierarchy).toBeDefined();
      expect(observation.skeleton).toBeUndefined();
    });

    // Issue #5886: the skeleton default + raw/project opt-out now extends to
    // every observation-producing action tool, not just the original three.
    // swipeOn is the representative extra tool named in the issue's test AC.
    describe("extended to all observation-producing action tools (#5886)", () => {
      test("swipeOn's observation defaults to the compact skeleton", () => {
        const response = createStructuredToolResponse({
          success: true,
          observation: makeObserveResult(),
        });
        const finalized = finalizeToolResponse(response, { name: "swipeOn" });
        const observation = (finalized.structuredContent as any).observation;
        expect(Array.isArray(observation.skeleton)).toBe(true);
        expect(observation.viewHierarchy).toBeUndefined();
        expect(observation.elements).toBeUndefined();
      });

      test('swipeOn honors project:"full" back into the raw viewHierarchy', () => {
        const response = createStructuredToolResponse({
          success: true,
          observation: makeObserveResult(),
        });
        const finalized = finalizeToolResponse(response, {
          name: "swipeOn",
          args: { project: "full" },
        });
        const observation = (finalized.structuredContent as any).observation;
        expect(observation.viewHierarchy).toBeDefined();
        expect(observation.skeleton).toBeUndefined();
      });

      test("swipeOn honors raw:true back into the raw viewHierarchy", () => {
        const response = createStructuredToolResponse({
          success: true,
          observation: makeObserveResult(),
        });
        const finalized = finalizeToolResponse(response, {
          name: "swipeOn",
          args: { raw: true },
        });
        const observation = (finalized.structuredContent as any).observation;
        expect(observation.viewHierarchy).toBeDefined();
        expect(observation.skeleton).toBeUndefined();
      });

      // A representative sample of the newly-covered tools all skeletonize by
      // default (the full roster is bound to the opt-out by the anti-divergence
      // test in test/server/tools/schema.integration.test.ts).
      test.each(["dragAndDrop", "pressButton", "rotate", "homeScreen", "terminateApp"])(
        "%s defaults its observation to the compact skeleton",
        (toolName) => {
          const response = createStructuredToolResponse({
            success: true,
            observation: makeObserveResult(),
          });
          const finalized = finalizeToolResponse(response, { name: toolName });
          const observation = (finalized.structuredContent as any).observation;
          expect(Array.isArray(observation.skeleton)).toBe(true);
          expect(observation.viewHierarchy).toBeUndefined();
        },
      );
    });

    test("a tool NOT in the skeleton-default set keeps the full hierarchy", () => {
      // The default remains scoped to the advertised set: a tool outside it (here
      // a synthetic name that embeds an observation but never opts in) must NOT be
      // silently skeletonized — the raw tree stays recoverable.
      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResult(),
      });
      const finalized = finalizeToolResponse(response, { name: "someUncoveredTool" });
      const observation = (finalized.structuredContent as any).observation;
      expect(observation.viewHierarchy).toBeDefined();
      expect(observation.skeleton).toBeUndefined();
    });
  });

  test("EC4: elements are kept only when the include-elements gate is enabled", () => {
    // Elements are dropped by default now; `--observe-result-include-elements`
    // opts back in. project:"full" keeps the headline hierarchy so `elements`
    // is the field under test rather than the skeleton default.
    serverConfig.setObserveResultIncludeElementsEnabled(true);
    const keep = finalizeToolResponse(createStructuredToolResponse(makeObserveResult()), {
      name: "observe",
      args: { project: "full" },
    });
    expect((keep.structuredContent as ObserveResult).elements).toBeDefined();

    serverConfig.setObserveResultIncludeElementsEnabled(false);
    const drop = finalizeToolResponse(createStructuredToolResponse(makeObserveResult()), {
      name: "observe",
      args: { project: "full" },
    });
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
    const finalized = finalizeToolResponse(createStructuredToolResponse(obs), {
      name: "observe",
      args: { project: "full" },
    });

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
    const withExtras = {
      ...obs,
      awaitedElement: { text: "Found" },
      awaitDuration: 250,
      awaitTimeout: false,
    };
    const finalized = finalizeToolResponse(createStructuredToolResponse(withExtras), {
      name: "observe",
      args: { project: "full" },
    });

    const sc = finalized.structuredContent as any;
    expect(sc.awaitedElement).toEqual({ text: "Found" });
    expect(sc.awaitDuration).toBe(250);
    // Hierarchy still trimmed alongside the preserved extras.
    expect(sc.viewHierarchy.hierarchy.node["view-id"]).toBeUndefined();
  });

  test("drops elements on an action's nested .observation by default", () => {
    const response = createStructuredToolResponse({
      success: true,
      observation: makeObserveResult(),
    });
    const finalized = finalizeToolResponse(response, { name: "tapOn" });
    expect((finalized.structuredContent as any).observation.elements).toBeUndefined();
    expect(JSON.parse(finalized.content[0].text).observation.elements).toBeUndefined();
  });

  test("trims an array-shaped root node (both roots)", () => {
    const obs = makeObserveResult();
    obs.viewHierarchy!.hierarchy.node = [
      { "resource-id": "a", "view-id": "a", clickable: "false" } as any,
      { "resource-id": "b", "view-id": "b", focusable: "false" } as any,
    ] as any;
    const finalized = finalizeToolResponse(createStructuredToolResponse(obs), {
      name: "observe",
      args: { project: "full" },
    });
    const roots = (finalized.structuredContent as any).viewHierarchy.hierarchy.node;
    expect(roots[0]["view-id"]).toBeUndefined();
    expect(roots[0].clickable).toBeUndefined();
    expect(roots[1]["view-id"]).toBeUndefined();
    expect(roots[1].focusable).toBeUndefined();
  });

  test("falls back to content text when structuredContent is absent", () => {
    const obs = makeObserveResult();
    const textOnly: any = { content: [{ type: "text", text: JSON.stringify(obs) }] };
    const finalized = finalizeToolResponse(textOnly, {
      name: "observe",
      args: { project: "full" },
    });
    const root = JSON.parse(finalized.content[0].text).viewHierarchy.hierarchy.node;
    expect(root["view-id"]).toBeUndefined();
    expect(root.clickable).toBeUndefined();
  });

  test("EC-C: compaction flattens node bounds in both structuredContent and text (permanent default)", () => {
    const finalized = finalizeToolResponse(
      createStructuredToolResponse(makeObserveResultWithBounds()),
      { name: "observe", args: { project: "full" } },
    );

    const rootSc = (finalized.structuredContent as any).viewHierarchy.hierarchy.node;
    expect(rootSc.bounds).toEqual([0, 0, 1080, 1920]);
    expect(rootSc.node[0].bounds).toEqual([10, 20, 30, 40]);

    const rootText = JSON.parse(finalized.content[0].text).viewHierarchy.hierarchy.node;
    expect(rootText.bounds).toEqual([0, 0, 1080, 1920]);
    // Text mirrors structuredContent exactly.
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("EC-C: compaction flattens bounds on an action's nested .observation (tapOn path)", () => {
    const response = createStructuredToolResponse({
      success: true,
      observation: makeObserveResultWithBounds(),
    });
    const finalized = finalizeToolResponse(response, {
      name: "tapOn",
      sessionUuid: "s1",
      args: { project: "full" },
    });

    const obsSc = (finalized.structuredContent as any).observation;
    expect(obsSc.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
    expect(obsSc.viewHierarchy.hierarchy.node.node[0].bounds).toEqual([10, 20, 30, 40]);
    expect((finalized.structuredContent as any).success).toBe(true);

    // Text mirrors the sanitized structuredContent exactly on the .observation branch too.
    const parsed = JSON.parse(finalized.content[0].text);
    expect(parsed.observation.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("EC-C: bounds are always compacted to tuples with no opt-out (permanent default)", () => {
    // Compaction was formerly flag-gated; it is now unconditional, so even with no
    // explicit opt-in the served bounds are the positional tuple, never the object.
    const finalized = finalizeToolResponse(
      createStructuredToolResponse(makeObserveResultWithBounds()),
      { name: "observe", args: { project: "full" } },
    );
    const rootSc = (finalized.structuredContent as any).viewHierarchy.hierarchy.node;
    expect(Array.isArray(rootSc.bounds)).toBe(true);
    expect(rootSc.bounds).toEqual([0, 0, 1080, 1920]);
  });

  test("EC-C: compaction is output-only — the caller's in-memory bounds object is untouched", () => {
    const obs = makeObserveResultWithBounds();
    finalizeToolResponse(createStructuredToolResponse(obs), { name: "observe" });
    expect(obs.viewHierarchy!.hierarchy.node).not.toBeInstanceOf(Array);
    expect((obs.viewHierarchy!.hierarchy.node as any).bounds).toEqual({
      left: 0,
      top: 0,
      right: 1080,
      bottom: 1920,
    });
  });

  test("EC-C: compaction composes with the default elements-drop and the wire-strip flag", () => {
    // compaction (always on) + elements dropped by default + the wire-strip flag.
    const originalStrip = serverConfig.isToolResultsNoStructuredContentEnabled();
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    try {
      const obs = {
        ...makeObserveResultWithBounds(),
        elements: { clickable: [], scrollable: [], text: [], media: [] },
      };
      const finalized = finalizeToolResponse(createStructuredToolResponse(obs), {
        name: "observe",
        args: { project: "full" },
      });
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
      const finalized = finalizeToolResponse(createStructuredToolResponse(makeObserveResult()), {
        name: "observe",
      });
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
  // (compacted) observation is emitted:
  //   1. Enabling the diff flag never disables compaction — compaction is now an
  //      unconditional default, independent of the diff flag.
  //   2. That default holds under the diff flag too: a post-action observation still
  //      carries tuple bounds.
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

    test("EC-D1: compaction still flattens a post-action .observation when the diff flag is also on", () => {
      serverConfig.setActionsDiffObserveEnabled(true);

      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResultWithBounds(),
      });
      const finalized = finalizeToolResponse(response, {
        name: "tapOn",
        sessionUuid: "s1",
        args: { project: "full" },
      });

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
      expect(obsSc.viewHierarchy.hierarchy.node.node[0].bounds).toEqual([10, 20, 30, 40]);
      expect((finalized.structuredContent as any).success).toBe(true);

      // Text mirrors the sanitized structuredContent exactly on the diffed .observation branch.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.viewHierarchy.hierarchy.node.bounds).toEqual([0, 0, 1080, 1920]);
      expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
    });

    test("EC-D2: the diff flag on still compacts — bounds are the tuple (compaction is unconditional)", () => {
      serverConfig.setActionsDiffObserveEnabled(true);

      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResultWithBounds(),
      });
      const finalized = finalizeToolResponse(response, {
        name: "tapOn",
        args: { project: "full" },
      });

      const node = (finalized.structuredContent as any).observation.viewHierarchy.hierarchy.node;
      expect(Array.isArray(node.bounds)).toBe(true);
      expect(node.bounds).toEqual([0, 0, 1080, 1920]);
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
              node: [{ "resource-id": "com.example:id/child", text: "Hello" } as any],
            } as any,
          },
        },
      } as ObserveResult;
    }

    /** In-memory baseline store standing in for the sessionManager cache slot. */
    function makeStore(): {
      store: {
        get: (u: string) => ObserveResult | undefined;
        set: (u: string, o: ObserveResult) => void;
      };
      map: Map<string, ObserveResult>;
    } {
      const map = new Map<string, ObserveResult>();
      return {
        map,
        store: {
          get: (u: string) => map.get(u),
          set: (u: string, o: ObserveResult) => {
            map.set(u, o);
          },
        },
      };
    }

    function expectObservationDiff(
      finalized: { structuredContent?: unknown; content: Array<{ text: string }> },
      expected: Record<string, unknown>,
    ): any {
      const metadata = (finalized.structuredContent as any).observationDiff;
      expect(metadata).toMatchObject(expected);
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observationDiff).toEqual(metadata);
      return metadata;
    }

    function iosScreenObserve(
      key: string,
      confidence: "high" | "medium" | "low" = "high",
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
      confidence: "high" | "medium" | "low" = "high",
    ): ObserveResult {
      const observation = iosScreenObserve(key, confidence);
      (observation.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      return observation;
    }

    function finalizeChangedLowConfidenceAction(
      name: string,
      actionArgs: Record<string, unknown>,
      key = "bundle=com.apple.reminders|focus=Title",
      nextKey = key,
    ): StructuredToolResponse<{ success: boolean; observation: ObserveResult }> {
      const { store } = makeStore();
      const baseline = iosScreenObserve(key, "low");
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      return finalizeToolResponse(
        createStructuredToolResponse({
          success: true,
          observation: checkedIosScreenObserve(nextKey, "low"),
        }),
        {
          name,
          args: { ...actionArgs, project: "full" },
          sessionUuid: "s1",
          baselineStore: store,
        },
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
      const response = createStructuredToolResponse({
        success: true,
        observation: sameScreenObserve(),
      });
      const finalized = finalizeToolResponse(response, {
        name: "tapOn",
        sessionUuid: "s1",
        baselineStore: store,
        // project:"full" opts out of the #5872 skeleton default so the "full, not a
        // diff" path under test keeps its raw hierarchy; the diff/store behavior is
        // the actual subject here.
        args: { project: "full" },
      });

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
        // project:"full" so the SERVED observe payload keeps its viewHierarchy; the
        // diff baseline is the full sanitized tree regardless of projection.
        args: { project: "full" },
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
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      // Next action toggles a child's `checked` on the same screen.
      const next = sameScreenObserve();
      (next.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, args: { project: "full" } },
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

    test("a diffed observation ALWAYS carries a usable `skeleton` alongside it (issue #6221 item 4.1)", () => {
      const { store } = makeStore();
      /** Same-screen observation whose `elements` block yields a non-empty skeleton. */
      const withSkeletonElements = (): ObserveResult => ({
        ...sameScreenObserve(),
        elements: {
          clickable: [
            {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "com.example:id/btn",
              text: "Submit",
              clickable: "true",
            } as any,
          ],
          scrollable: [],
          text: [],
          media: [],
        },
      });

      finalizeToolResponse(createStructuredToolResponse(withSkeletonElements()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = withSkeletonElements();
      (next.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      // Default projection (no `project`/`raw` arg) — the case the issue's dogfood
      // repro hit: a diff response with no skeleton to act on.
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBe(true);
      // The diff is real (a change happened)...
      expect(obsSc.changed).toHaveLength(1);
      // ...AND it still carries a full, usable actionable-only skeleton — never
      // absent just because a diff was emitted.
      expect(Array.isArray(obsSc.skeleton)).toBe(true);
      expect(obsSc.skeleton.length).toBeGreaterThan(0);
      expect(obsSc.skeleton[0].elementId).toBe("com.example:id/btn");
      expect(obsSc.skeleton[0].affordances).toContain("tap");

      // Text mirror agrees.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.skeleton.length).toBe(obsSc.skeleton.length);
    });

    test("a diffed observation carries a usable `skeleton` even under raw:true / project:'full' (PR #6242 review PRRT_kwDOP-GF5M6fq3iK)", () => {
      const { store } = makeStore();
      const withSkeletonElements = (): ObserveResult => ({
        ...sameScreenObserve(),
        elements: {
          clickable: [
            {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "com.example:id/btn",
              text: "Submit",
              clickable: "true",
            } as any,
          ],
          scrollable: [],
          text: [],
          media: [],
        },
      });

      finalizeToolResponse(createStructuredToolResponse(withSkeletonElements()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = withSkeletonElements();
      (next.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      // `project: "full"` — servedObservation itself carries NO skeleton in this
      // mode (it is the raw sanitized tree), so the diff must re-project one
      // independently rather than emitting `skeleton: []`.
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, args: { project: "full" } },
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.viewHierarchy).toBeUndefined();
      expect(Array.isArray(obsSc.skeleton)).toBe(true);
      expect(obsSc.skeleton.length).toBeGreaterThan(0);
      expect(obsSc.skeleton[0].elementId).toBe("com.example:id/btn");
    });

    test("a diffed observation ALSO carries the state-readout `context` alongside `skeleton` (issue #6256)", () => {
      const { store } = makeStore();
      // A zero-affordance readout (e.g. a timer countdown) plus one actionable
      // button — the shape `--actions-diff-observe` must not silently drop the
      // readout from, the same way #6221 item 4.1 already guarantees `skeleton`.
      const withReadout = (readoutText: string): ObserveResult => ({
        ...sameScreenObserve(),
        elements: {
          clickable: [
            {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "com.example:id/btn",
              text: "Start",
              clickable: "true",
            } as any,
          ],
          scrollable: [],
          text: [
            {
              bounds: { left: 0, top: 60, right: 100, bottom: 90 },
              "resource-id": "com.example:id/countdown",
              text: readoutText,
            } as any,
          ],
          media: [],
        },
      });

      finalizeToolResponse(createStructuredToolResponse(withReadout("00h 20m 00s")), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      // A tap changes the hierarchy (so a real diff is emitted) AND the readout's
      // own text updates — the exact failed-vs-successful-input distinction the
      // client needs to make.
      const next = withReadout("00h 19m 59s");
      (next.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.changed).toHaveLength(1);
      expect(Array.isArray(obsSc.context)).toBe(true);
      expect(obsSc.context).toHaveLength(1);
      expect(obsSc.context[0]).toMatchObject({
        elementId: "com.example:id/countdown",
        label: "00h 19m 59s",
        affordances: [],
      });

      // Text mirror agrees.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.observation.context).toEqual(obsSc.context);
    });

    test("a diff with no surviving readout row omits `context` entirely rather than emitting `[]`", () => {
      const { store } = makeStore();
      const withSkeletonElements = (): ObserveResult => ({
        ...sameScreenObserve(),
        elements: {
          clickable: [
            {
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              "resource-id": "com.example:id/btn",
              text: "Submit",
              clickable: "true",
            } as any,
          ],
          scrollable: [],
          text: [],
          media: [],
        },
      });

      finalizeToolResponse(createStructuredToolResponse(withSkeletonElements()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = withSkeletonElements();
      (next.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.context).toBeUndefined();
    });

    test("returns a full observation when a reported screen change would emit an empty diff", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({
          success: true,
          effect: { screenChanged: true, basis: "viewHierarchy changed" },
          observation: sameScreenObserve(),
        }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, args: { project: "full" } },
      );

      const observation = (finalized.structuredContent as any).observation;
      expect(observation.isDiff).toBeUndefined();
      expect(observation.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("hierarchy-less action observations emit full sanitized payloads, not empty diffs", () => {
      const { store, map } = makeStore();
      const baseline = sameScreenObserve();
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

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
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, args: { project: "full" } },
      );
      const second = finalizeToolResponse(
        createStructuredToolResponse({ success: false, observation: hierarchyLess(13) }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
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
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      const metadata = expectObservationDiff(finalized, {
        mode: "full",
        reason: "unrenderable_hierarchy",
      });
      expect(metadata.fromScreen.activeWindow.appId).toBe("com.example");
      expect(metadata.toScreen.activeWindow.appId).toBe("com.example");
      expect(map.get("s1")!.viewHierarchy?.hierarchy).toBeDefined();
    });

    test("a non-observe action updates the baseline to its own observation (next diff is against current state)", () => {
      const { store, map } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = sameScreenObserve();
      (next.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      finalizeToolResponse(createStructuredToolResponse({ success: true, observation: next }), {
        name: "tapOn",
        sessionUuid: "s1",
        baselineStore: store,
      });

      // Baseline now reflects the post-action observation (checked=true present).
      const baseline = map.get("s1")!;
      expect((baseline.viewHierarchy!.hierarchy.node as any).node[0].checked).toBe("true");
    });

    test("falls back to the full observation when the baseline is missing", () => {
      const { store, map } = makeStore();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
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
        { name: "tapOn", sessionUuid: "s1", args: { project: "full" } },
      );
      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, {
        mode: "full",
        reason:
          "missing_session — pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations",
      });
    });

    test("default projection still skeletonizes a missing-session full fallback", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1" },
      );
      const observation = (finalized.structuredContent as any).observation;
      expect(observation.isDiff).toBeUndefined();
      expect(observation.skeleton).toBeDefined();
      expect(observation.viewHierarchy).toBeUndefined();
      expectObservationDiff(finalized, {
        mode: "full",
        reason:
          "missing_session — pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations",
      });
    });

    test("falls back to full when the screen (app/activity/package) changed", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const otherScreen = {
        ...sameScreenObserve(),
        activeWindow: { appId: "com.other", activityName: ".Other", layoutSeqSum: 2 },
      } as ObserveResult;
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: otherScreen }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, args: { project: "full" } },
      );
      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      const metadata = expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
      expect(metadata.fromScreen.activeWindow.appId).toBe("com.example");
      expect(metadata.toScreen.activeWindow.appId).toBe("com.other");
    });

    test("preserves default skeleton projection when the screen changed", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const otherScreen = {
        ...sameScreenObserve(),
        activeWindow: { appId: "com.other", activityName: ".Other", layoutSeqSum: 2 },
      } as ObserveResult;
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: otherScreen }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );
      const observation = (finalized.structuredContent as any).observation;

      expect(observation.isDiff).toBeUndefined();
      expect(observation.skeleton).toBeDefined();
      expect(observation.viewHierarchy).toBeUndefined();
      expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
    });

    test("falls back to full when an iOS screen identity changes under the same app", () => {
      const { store } = makeStore();
      const baseline = iosScreenObserve("bundle=com.apple.reminders|nav=Reminders");
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|nav=New Reminder");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expect(obsSc.screenIdentity.key).toBe("bundle=com.apple.reminders|nav=New Reminder");
      const metadata = expectObservationDiff(finalized, { mode: "full", reason: "screen_changed" });
      expect(metadata.fromScreen.screenIdentity.key).toBe(
        "bundle=com.apple.reminders|nav=Reminders",
      );
      expect(metadata.toScreen.screenIdentity.key).toBe(
        "bundle=com.apple.reminders|nav=New Reminder",
      );
    });

    test("emits a diff when high-confidence iOS screen identity stays stable", () => {
      const { store } = makeStore();
      const baseline = iosScreenObserve("bundle=com.apple.reminders|nav=Reminders");
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|nav=Reminders");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
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
        { name: "observe", sessionUuid: "s1", baselineStore: store },
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
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
      );

      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBe(true);
      expect(obsSc.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
    });

    test("falls back to full when medium-confidence iOS screen identity changes under the same app", () => {
      const { store } = makeStore();
      const baseline = iosScreenObserve("bundle=com.apple.reminders|tab=Inbox", "medium");
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|tab=Search", "medium");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
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
      finalizeToolResponse(createStructuredToolResponse(baseline), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = checkedIosScreenObserve("bundle=com.apple.reminders|focus=Title", "low");

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          args: { project: "full" },
        },
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
        "bundle=com.apple.reminders|list=Inbox",
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
        "bundle=com.apple.reminders|focus=Search",
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
        "bundle=com.apple.reminders|list=Search",
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
      const inputSearch = finalizeChangedLowConfidenceAction("inputText", {
        text: "query",
        imeAction: "search",
      });
      expect((inputSearch.structuredContent as any).observation.isDiff).toBeUndefined();
      expect((inputSearch.structuredContent as any).observation.viewHierarchy).toBeDefined();
      expectObservationDiff(inputSearch, { mode: "full", reason: "screen_changed" });

      const imeGo = finalizeChangedLowConfidenceAction("imeAction", { action: "go" });
      expect((imeGo.structuredContent as any).observation.isDiff).toBeUndefined();
      expect((imeGo.structuredContent as any).observation.viewHierarchy).toBeDefined();
      expectObservationDiff(imeGo, { mode: "full", reason: "screen_changed" });
    });

    test("action policy: focus-traversal IME actions remain in-place", () => {
      const inputNext = finalizeChangedLowConfidenceAction("inputText", {
        text: "value",
        imeAction: "next",
      });
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
      },
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
      },
    );

    test("falls back to full when there is no sessionUuid (legacy single-agent path)", () => {
      const { store, map } = makeStore();
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", baselineStore: store, args: { project: "full" } },
      );
      const obsSc = (finalized.structuredContent as any).observation;
      expect(obsSc.isDiff).toBeUndefined();
      expect(obsSc.viewHierarchy).toBeDefined();
      expectObservationDiff(finalized, {
        mode: "full",
        reason:
          "missing_session — pass sessionUuid from getAndroid/getApple to receive diffs instead of full observations",
      });
      expect(map.size).toBe(0);
    });

    test("observe resets the baseline after a diff-producing action", () => {
      const { store, map } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });
      const first = map.get("s1");
      // An observe with a different hierarchy overwrites the baseline wholesale.
      const reset = sameScreenObserve();
      (reset.viewHierarchy!.hierarchy.node as any)["content-desc"] = "changed-root";
      finalizeToolResponse(createStructuredToolResponse(reset), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });
      const second = map.get("s1")!;
      expect(second).not.toBe(first);
      expect((second.viewHierarchy!.hierarchy.node as any)["content-desc"]).toBe("changed-root");
    });

    test("diff path is output-only — the caller's in-memory observation is untouched", () => {
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });
      const next = sameScreenObserve();
      (next.viewHierarchy!.hierarchy.node as any).node[0].checked = "true";
      const before = JSON.stringify(next);
      finalizeToolResponse(createStructuredToolResponse({ success: true, observation: next }), {
        name: "tapOn",
        sessionUuid: "s1",
        baselineStore: store,
      });
      expect(JSON.stringify(next)).toBe(before);
    });

    test("the emitted diff carries tuple-shaped bounds in its node attributes", () => {
      // The diff runs on the sanitized (always-compacted) observation, so a node
      // surfaced in the diff carries the tuple bounds, not the object shape.
      const { store } = makeStore();
      const withBounds = (): ObserveResult =>
        ({
          ...makeObserveResult(),
          activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
          viewHierarchy: {
            packageName: "com.example",
            hierarchy: {
              node: {
                "resource-id": "com.example:id/root",
                bounds: { left: 0, top: 0, right: 100, bottom: 100 },
              } as any,
            },
          },
        }) as ObserveResult;

      finalizeToolResponse(createStructuredToolResponse(withBounds()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = withBounds();
      (next.viewHierarchy!.hierarchy.node as any).node = [
        { "resource-id": "com.example:id/added", bounds: { left: 5, top: 6, right: 7, bottom: 8 } },
      ];
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
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
              bounds: { left: 0, top: 0, right: 100, bottom: 100 },
              node: [{ "resource-id": "com.example:id/child", text: "Hello" } as any],
            } as any,
          },
        },
      } as ObserveResult;
    }

    function makeStore(): {
      store: {
        get: (u: string) => ObserveResult | undefined;
        set: (u: string, o: ObserveResult) => void;
      };
      map: Map<string, ObserveResult>;
    } {
      const map = new Map<string, ObserveResult>();
      return {
        map,
        store: {
          get: (u: string) => map.get(u),
          set: (u: string, o: ObserveResult) => {
            map.set(u, o);
          },
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
        // project:"full" so the artifacted observation is the full sanitized tree
        // (the view-id dedup under test) rather than the default skeleton.
        {
          name: "observe",
          sessionUuid: "s1",
          artifactWriter: writer,
          args: { project: "full" },
        } as any,
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
      expect(
        (writer.writes[0].data as any).viewHierarchy.hierarchy.node["view-id"],
      ).toBeUndefined();
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
        { name: "observe", sessionUuid: "s1", artifactWriter: writer } as any,
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
        // project:"full" keeps the raw hierarchy under test; the assertions below
        // check that the FULL observation (not the #5872 skeleton default) is the
        // payload handed to the artifact writer.
        {
          name: "tapOn",
          sessionUuid: "s1",
          args: { project: "full" },
          artifactWriter: writer,
        } as any,
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
      expect(
        (writer.writes[0].data as any).viewHierarchy.hierarchy.node["view-id"],
      ).toBeUndefined();
      expect(JSON.parse(finalized.content[0].text)).toEqual(finalized.structuredContent);
    });

    test("artifact writer receives the compacted diff after existing output transforms", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      const { store } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });

      const next = sameScreenObserve();
      (next.viewHierarchy!.hierarchy.node as any).node = [
        { "resource-id": "com.example:id/added", bounds: { left: 5, top: 6, right: 7, bottom: 8 } },
      ];
      const writer = new FakeObservationArtifactWriter();

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: next }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, artifactWriter: writer } as any,
      );

      expect((writer.writes[0].data as any).isDiff).toBe(true);
      expect(writer.writes[0].payload).toBe("ObserveDiff");
      expect((writer.writes[0].data as any).added[0].attributes.bounds).toEqual([5, 6, 7, 8]);
      expect((finalized.structuredContent as any).observation.artifact.path).toBe(
        "/tmp/auto-mobile/tapOn-1.json",
      );
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
        { name: "tapOn", sessionUuid: "s1", internal: true, artifactWriter: writer } as any,
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

      expect(() =>
        finalizeToolResponse(response, {
          name: "observe",
          sessionUuid: "s1",
          artifactWriter: writer,
        } as any),
      ).toThrow("artifact disk is full");
      expect((response.structuredContent as any).viewHierarchy).toBeDefined();
      expect((response.structuredContent as any).artifact).toBeUndefined();
    });

    test("artifact write failures do not advance the diff baseline", () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      const { store, map } = makeStore();
      finalizeToolResponse(createStructuredToolResponse(sameScreenObserve()), {
        name: "observe",
        sessionUuid: "s1",
        baselineStore: store,
      });
      const renderedBaseline = map.get("s1");
      const next = sameScreenObserve();
      (next.viewHierarchy!.hierarchy.node as any).node = [
        {
          "resource-id": "com.example:id/not-rendered",
          bounds: { left: 1, top: 2, right: 3, bottom: 4 },
        },
      ];
      const writer = new FakeObservationArtifactWriter();
      writer.throwOnWrite = new Error("artifact disk is full");

      expect(() =>
        finalizeToolResponse(createStructuredToolResponse({ success: true, observation: next }), {
          name: "tapOn",
          sessionUuid: "s1",
          baselineStore: store,
          artifactWriter: writer,
        } as any),
      ).toThrow("artifact disk is full");
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
        ({ name: "tapOn", artifactMode: "oversized", artifactWriter: writer }) as any;

      // Build a tapOn response padded so the object measured by the size gate
      // serializes to exactly `targetBytes`. The `pad` field is copied verbatim
      // into the served payload (only `observation` is transformed), so each ASCII
      // char is exactly one UTF-8 byte. A zero-pad probe stays inline — far under
      // 64KB — so its returned structuredContent IS the object the gate measures,
      // giving the base size to calibrate against.
      function tapResponseOfSize(targetBytes: number): StructuredToolResponse {
        const build = (pad: string) =>
          createStructuredToolResponse({ success: true, pad, observation: makeObserveResult() });
        const probe = finalizeToolResponse(
          build(""),
          oversizedCtx(new FakeObservationArtifactWriter()),
        );
        const baseBytes = Buffer.byteLength(stringifyToolResponse(probe.structuredContent), "utf8");
        return build("x".repeat(targetBytes - baseBytes));
      }

      test("a served payload exactly at 65536 bytes stays inline", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          tapResponseOfSize(INLINE_MAX_BYTES),
          oversizedCtx(writer),
        );

        expect(Buffer.byteLength(stringifyToolResponse(finalized.structuredContent), "utf8")).toBe(
          65536,
        );
        expect(writer.writes).toHaveLength(0);
        // Inline (not artifacted): the observation is present as the #5872 skeleton
        // default, not replaced by artifact metadata.
        expect((finalized.structuredContent as any).observation.skeleton).toBeDefined();
        expect((finalized.structuredContent as any).observation.artifact).toBeUndefined();
      });

      test("a served payload one byte over 65536 is routed to the artifact writer", () => {
        const writer = new FakeObservationArtifactWriter();
        const finalized = finalizeToolResponse(
          tapResponseOfSize(FIRST_ARTIFACT_BYTES),
          oversizedCtx(writer),
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
        rawViewHierarchy: '<hierarchy><node text="large" /></hierarchy>',
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
        rawViewHierarchy: '<hierarchy><node text="debug failure" /></hierarchy>',
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

      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "executePlan",
        artifactWriter: writer,
      } as any);

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

      const finalizedStepObservation = (finalized.structuredContent as any).debug.steps[0].details
        .stepObservation;
      expect(finalizedStepObservation.visibleTextsSample).toEqual(["Step"]);
      expect(finalizedStepObservation.viewHierarchy.artifact.payload).toBe(
        "ExecutePlanDebugStepObservationViewHierarchy",
      );
      const finalizedDebugFailureObservation = (finalized.structuredContent as any).debug.steps[0]
        .details.failureObservation;
      expect(finalizedDebugFailureObservation.visibleTextsSample).toEqual(["Debug failure"]);
      expect(finalizedDebugFailureObservation.viewHierarchy.artifact.payload).toBe(
        "ExecutePlanDebugFailureObservationViewHierarchy",
      );
      expect(finalizedDebugFailureObservation.rawViewHierarchy.artifact.payload).toBe(
        "ExecutePlanDebugFailureObservationRawViewHierarchy",
      );
      expect(writer.writes.map((write) => write.payload)).toEqual([
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

      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "getNetworkGraph",
        artifactWriter: writer,
      } as any);

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

      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "executePlan",
        internal: true,
        artifactWriter: writer,
      } as any);

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
      const response = createStructuredToolResponse({
        success: true,
        observation: makeObserveResult(),
      });
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
      const finalized = finalizeToolResponse(createStructuredToolResponse(makeObserveResult()), {
        name: "observe",
        sessionUuid: "s1",
        args: { project: "full" },
      });
      // observe still returns the full (sanitized) observation.
      expect((finalized.structuredContent as any).viewHierarchy).toBeDefined();
    });

    test("flag off leaves the observation in place (today's behavior)", () => {
      serverConfig.setActionsNoObserveEnabled(false);
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        { name: "tapOn" },
      );
      expect((finalized.structuredContent as any).observation).toBeDefined();
    });

    test("precedence: with both no-observe and diff on, the observation is stripped (no diff)", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      serverConfig.setActionsDiffObserveEnabled(true);
      const map = new Map<string, ObserveResult>();
      const store = {
        get: (u: string) => map.get(u),
        set: (u: string, o: ObserveResult) => {
          map.set(u, o);
        },
      };

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: makeObserveResult() }),
        { name: "tapOn", sessionUuid: "s1", baselineStore: store },
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
      const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
        name: "pressButton",
      });
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
              node: [{ "resource-id": "com.example:id/child", text: "Hello" } as any],
            } as any,
          },
        },
      } as ObserveResult;
    }

    function makeStore(): {
      store: {
        get: (u: string) => ObserveResult | undefined;
        set: (u: string, o: ObserveResult) => void;
      };
      map: Map<string, ObserveResult>;
    } {
      const map = new Map<string, ObserveResult>();
      return {
        map,
        store: {
          get: (u: string) => map.get(u),
          set: (u: string, o: ObserveResult) => {
            map.set(u, o);
          },
        },
      };
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
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, internal: true },
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
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, internal: true },
      );

      // Internal calls neither read a diff nor advance the agent-facing baseline.
      expect(map.get("s1")).toBe(before);
    });

    test("EC2.2: internal call preserves the observation even with --actions-no-observe on", () => {
      serverConfig.setActionsNoObserveEnabled(true);
      serverConfig.setActionsDiffObserveEnabled(false);

      const finalized = finalizeToolResponse(
        createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
        { name: "tapOn", sessionUuid: "s1", internal: true },
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
        { name: "tapOn", sessionUuid: "s1", internal: true },
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
        { name: "tapOn", sessionUuid: "s1", baselineStore: store, internal: false },
      );

      expect((finalized.structuredContent as any).observation.isDiff).toBe(true);
    });
  });

  describe("skeleton projection (issue #4388)", () => {
    // Skeleton is now the unconditional default projection for the headline observe
    // payload; `project:"full"` / `raw:true` opt out. The old project-skeleton flag
    // is gone, so there is no flag to save/restore here.

    /** An observe result whose elements carry bounds so the skeleton is non-empty. */
    function observeWithActionableElements(): ObserveResult {
      const obs = makeObserveResult();
      obs.elements = {
        clickable: [
          {
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            "resource-id": "com.example:id/btn",
            text: "Submit",
            clickable: "true",
            "test-tag": "submit-with-terms",
            "semantic-links": [{ text: "Terms", occurrence: 0, start: 7, end: 12 }],
          } as any,
        ],
        scrollable: [],
        text: [],
        media: [],
      };
      return obs;
    }

    test("default (no project arg): observe returns a skeleton and omits viewHierarchy + elements", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe" },
      );
      const sc = finalized.structuredContent as ObserveResult;
      expect(Array.isArray(sc.skeleton)).toBe(true);
      expect(sc.skeleton!.length).toBeGreaterThan(0);
      expect(sc.viewHierarchy).toBeUndefined();
      expect(sc.elements).toBeUndefined();
      expect(sc.skeleton![0].testTag).toBe("submit-with-terms");
      expect(sc.skeleton![0].semanticLinks).toEqual([
        { text: "Terms", occurrence: 0, start: 7, end: 12 },
      ]);
      // text mirror agrees with structuredContent.
      const parsed = JSON.parse(finalized.content[0].text);
      expect(parsed.skeleton.length).toBe(sc.skeleton!.length);
    });

    test("per-call project:'skeleton' arg also projects to the skeleton", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe", args: { project: "skeleton" } },
      );
      const sc = finalized.structuredContent as ObserveResult;
      expect(sc.skeleton).toBeDefined();
      expect(sc.viewHierarchy).toBeUndefined();
    });

    test("explicit project:'full' opts out of the skeleton default (full tree returned)", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe", args: { project: "full" } },
      );
      const sc = finalized.structuredContent as ObserveResult;
      expect(sc.skeleton).toBeUndefined();
      expect(sc.viewHierarchy?.hierarchy).toBeDefined();
    });

    test("raw:true opts out to the full tree", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse(observeWithActionableElements()),
        { name: "observe", args: { raw: true } },
      );
      const sc = finalized.structuredContent as ObserveResult;
      expect(sc.skeleton).toBeUndefined();
      expect(sc.viewHierarchy?.hierarchy).toBeDefined();
    });

    test("embedded action observations now skeletonize by default too (#5872 superseded #4388's scoping)", () => {
      const finalized = finalizeToolResponse(
        createStructuredToolResponse({
          success: true,
          observation: observeWithActionableElements(),
        }),
        { name: "tapOn", sessionUuid: "s1" },
      );
      const obsSc = (finalized.structuredContent as any).observation as ObserveResult;
      // Issue #5872: the skeleton default extended to the action tools' embedded
      // observation, using the same `skeleton` key `observe` uses.
      expect(obsSc.skeleton).toBeDefined();
      expect(obsSc.viewHierarchy).toBeUndefined();
    });
  });
});

/**
 * Observe scope experiments (issue #4344). The per-call `scope` request arrives on
 * the observe tool args. The per-dimension server gates are now always on, so a
 * requested dimension is honored purely from the `scope` arg (nothing is gated
 * off). Scoping is applied to the agent-facing payload only — it must leave the
 * diff baseline (the full sanitized tree) intact and never touch internal
 * tool-to-tool calls. It runs on the FULL projection; the skeleton default
 * replaces the hierarchy, so these tests opt into `project:"full"` to exercise the
 * structural scope transforms.
 */
describe("finalizeToolResponse observe scope experiments (#4344)", () => {
  beforeEach(() => {
    serverConfig.setActionsDiffObserveEnabled(false);
  });

  afterEach(() => {
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
            class: "Root",
            bounds: { left: 0, top: 0, right: 1000, bottom: 2000 },
            // Package-qualified resource-ids are the app-vs-chrome signal that
            // survives cleanNodeProperties (per-node `package` does not).
            node: [
              {
                "resource-id": "com.android.systemui:id/status_bar",
                bounds: { left: 0, top: 0, right: 1000, bottom: 100 },
              },
              {
                "resource-id": "com.example.app:id/content",
                text: "Hi",
                bounds: { left: 0, top: 100, right: 1000, bottom: 1900 },
              },
            ],
          } as any,
        },
      },
    } as ObserveResult;
  }

  test("requested scope dimensions are no longer gated off (gates are always on)", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { project: "full", scope: { focus: true, region: true, overview: true } },
    });
    const out = finalized.structuredContent as ObserveResult;
    // Nothing is gated off now, and the scope transforms materially prune the tree.
    expect(out.observeScope!.gatedOff).toBeUndefined();
    expect(out.observeScope!.applied).toContain("focus");
    expect(out.observeScope!.nodesAfter).toBeLessThan(out.observeScope!.nodesBefore);
  });

  test("multiple requested dimensions are all honored (none gated off)", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { project: "full", scope: { focus: true, region: true } },
    });
    const out = finalized.structuredContent as ObserveResult;
    expect(out.observeScope).toMatchObject({ applied: ["focus"] });
    expect(out.observeScope!.gatedOff).toBeUndefined();
  });

  test("no scope in the call: payload is untouched (scope is a no-op)", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { project: "full" },
    });
    expect((finalized.structuredContent as ObserveResult).observeScope).toBeUndefined();
  });

  test("scope.focus in the call scopes the payload and records observeScope", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { project: "full", scope: { focus: true } },
    });
    const out = finalized.structuredContent as ObserveResult;
    expect(out.observeScope?.applied).toContain("focus");
    expect(out.observeScope!.nodesAfter).toBeLessThan(out.observeScope!.nodesBefore);
    // text mirror agrees with structuredContent.
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("explicit skeleton projection returns the skeleton; scope transforms cannot run on it", () => {
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
    // Gates are always on, so nothing is gated off; the skeleton replaces the
    // hierarchy, so no scope transform runs and no observeScope is recorded.
    expect(out.observeScope).toBeUndefined();
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("default skeleton + scope: skeleton returned, no observeScope (nothing gated off)", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { scope: { focus: true, region: true } },
    });

    const out = finalized.structuredContent as ObserveResult;
    expect(out.skeleton).toEqual([]);
    expect(out.viewHierarchy).toBeUndefined();
    expect(out.observeScope).toBeUndefined();
    expect(finalized.content[0].text).toBe(stringifyToolResponse(finalized.structuredContent));
  });

  test("scope.region box in the call crops to the normalized rectangle", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      args: { project: "full", scope: { region: { x1: 0, y1: 0, x2: 1, y2: 0.5 } } }, // top half only
    });
    const out = finalized.structuredContent as ObserveResult;
    expect(out.observeScope?.regionPx).toEqual({ left: 0, top: 0, right: 1000, bottom: 1000 });
  });

  test("internal observe calls are never scoped", () => {
    const finalized = finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      internal: true,
      args: { project: "full", scope: { focus: true } },
    });
    expect((finalized.structuredContent as ObserveResult).observeScope).toBeUndefined();
  });

  test("diff baseline is the full sanitized tree, not the scoped copy", () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    const map = new Map<string, ObserveResult>();
    const store = {
      get: (u: string) => map.get(u),
      set: (u: string, o: ObserveResult) => {
        map.set(u, o);
      },
    };

    finalizeToolResponse(createStructuredToolResponse(chromeObserve()), {
      name: "observe",
      sessionUuid: "s1",
      baselineStore: store,
      args: { project: "full", scope: { focus: true } },
    });

    // Baseline retains the system-chrome node the served payload dropped.
    const baseline = map.get("s1")!;
    expect(baseline.observeScope).toBeUndefined();
    const ids: string[] = [];
    const walk = (n: any): void => {
      if (n["resource-id"]) {
        ids.push(n["resource-id"]);
      }
      for (const c of n.node ?? []) {
        walk(c);
      }
    };
    walk(baseline.viewHierarchy!.hierarchy.node);
    expect(ids).toContain("com.android.systemui:id/status_bar");
  });
});

describe("finalizeToolResponse — scope-then-cap for layoutWarnings (issue #5074 finding 3)", () => {
  test("an in-region warning survives even when 100+ higher-priority warnings are out of region", () => {
    const W = 1080,
      H = 2400;
    // One in-region node (top) plus 120 out-of-region nodes (bottom), each distinct bounds.
    const inRegionBounds = { left: 0, top: 100, right: 200, bottom: 160 };
    const outNodes = Array.from({ length: 120 }, (_, i) => ({
      "resource-id": `com.example:id/out_${i}`,
      bounds: { left: 0, top: 1300 + i, right: 200, bottom: 1360 + i },
    }));
    const mkWarning = (
      bounds: Record<string, number>,
      severity: "warning" | "info",
      overflow: number,
    ): any => ({
      type: "important-content-under-inset",
      severity,
      element: { bounds },
      categories: ["text"],
      insetTypes: ["systemBars"],
      sides: ["top"],
      overflowPx: { top: overflow },
      insetPx: { top: overflow },
      overlapPercent: 100,
      confidence: "medium",
    });
    const obs = {
      updatedAt: 1,
      screenSize: { width: W, height: H },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      activeWindow: { appId: "com.example" },
      viewHierarchy: {
        packageName: "com.example",
        hierarchy: {
          node: {
            "resource-id": "com.example:id/root",
            bounds: { left: 0, top: 0, right: W, bottom: H },
            node: [{ text: "in", bounds: inRegionBounds }, ...outNodes],
          },
        },
      },
      layoutWarnings: {
        scope: "full",
        warnings: [
          // In-region warning is deliberately LOW priority, so a cap taken BEFORE
          // scoping (the bug) would evict it in favor of the 120 out-of-region ones.
          mkWarning(inRegionBounds, "info", 1),
          ...outNodes.map((n) => mkWarning(n.bounds, "warning", 999)),
        ],
      },
    } as unknown as ObserveResult;

    const finalized = finalizeToolResponse(createStructuredToolResponse(obs), {
      name: "observe",
      // project:"full" keeps the real hierarchy (default is the skeleton projection,
      // which replaces it and cannot co-scope warnings).
      args: { project: "full", scope: { region: { x1: 0, y1: 0, x2: 1, y2: 0.5 } } },
    });

    // Scope-then-cap: the crop keeps only the in-region node, so its warning is the
    // sole survivor — never evicted by the 120 higher-priority out-of-region ones.
    const served = finalized.structuredContent as ObserveResult;
    expect(served.layoutWarnings?.scope).toBe("scoped");
    expect(served.layoutWarnings?.warnings).toHaveLength(1);
  });
});
