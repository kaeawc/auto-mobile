import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse, stringifyToolResponse } from "../../src/utils/toolUtils";
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

describe("finalizeToolResponse", () => {
  let originalDropElements: boolean;

  beforeEach(() => {
    originalDropElements = serverConfig.isObserveResultDropElementsEnabled();
    serverConfig.setObserveResultDropElementsEnabled(false);
  });

  afterEach(() => {
    serverConfig.setObserveResultDropElementsEnabled(originalDropElements);
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

  test("EC5: observe payload without a viewHierarchy is a safe no-op", () => {
    const payload: any = { updatedAt: 1, screenSize: { width: 1, height: 1 }, systemInsets: {} };
    const response = createStructuredToolResponse(payload);
    const finalized = finalizeToolResponse(response, { name: "observe" });
    expect(finalized.structuredContent).toEqual(payload);
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
});
