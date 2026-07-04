import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stripToolResultStructuredContent } from "../../src/server/stripToolResultStructuredContent";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";

/**
 * Wire-boundary strip for the duplicated `structuredContent` tree.
 * `content[0].text` and `structuredContent` are byte-identical duplicates, so
 * dropping the latter halves the wire payload with no data loss. It is dropped
 * for no-schema tools unconditionally (issue #2759) and for schema tools when
 * the `--tool-results-no-structured-content` flag is set (issue #2899).
 *
 * Decision matrix (second arg = the tool's `hasOutputSchema`):
 *   hasOutputSchema | flag  | keep structuredContent?
 *   ----------------|-------|------------------------
 *   false           | off   | NO  (#2759 no-schema unconditional)
 *   false           | on    | NO
 *   true            | off   | YES (#2899 schema tool, spec-conforming)
 *   true            | on    | NO  (#2899 flag drops it too)
 */
describe("stripToolResultStructuredContent", () => {
  let original: boolean;

  beforeEach(() => {
    original = serverConfig.isToolResultsNoStructuredContentEnabled();
  });

  afterEach(() => {
    serverConfig.setToolResultsNoStructuredContentEnabled(original);
  });

  test("EC-A: drops structuredContent for a schema tool when the gate is enabled, keeps content text", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const payload = { success: true, message: "done", nested: { a: 1 } };
    const response = stripToolResultStructuredContent(createStructuredToolResponse(payload), true);

    expect("structuredContent" in response).toBe(false);
    expect(response.content[0].type).toBe("text");
    // Full payload is still recoverable from the retained text — no data loss.
    expect(JSON.parse(response.content[0].text)).toEqual(payload);
  });

  test("EC-B: preserves structuredContent for a schema tool when the gate is disabled", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    const response = stripToolResultStructuredContent(createStructuredToolResponse({ success: true }), true);
    expect(response.structuredContent).toEqual({ success: true });
  });

  test("EC-2759a: drops structuredContent for a no-schema tool even when the gate is disabled", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    const payload = { success: true, viewHierarchy: { node: [] } };
    const response = stripToolResultStructuredContent(createStructuredToolResponse(payload), false);
    expect("structuredContent" in response).toBe(false);
    // Text block is preserved — the model-facing surface is intact.
    expect(JSON.parse(response.content[0].text)).toEqual(payload);
  });

  test("EC-2759b: drops structuredContent for a no-schema tool when the gate is enabled", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const response = stripToolResultStructuredContent(createStructuredToolResponse({ success: true }), false);
    expect("structuredContent" in response).toBe(false);
  });

  test("EC-D: strips regardless of payload shape (covers plain-registered tools)", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    // e.g. exportPlan/recordSteps: declare an outputSchema, bypass finalizeToolResponse.
    const response = stripToolResultStructuredContent(
      createStructuredToolResponse({ success: true, plan: "steps:\n  - tapOn: {}" }),
      true
    );
    expect("structuredContent" in response).toBe(false);
    expect(JSON.parse(response.content[0].text).plan).toBe("steps:\n  - tapOn: {}");
  });

  test("EC-E: response without structuredContent is an unchanged no-op", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const imageResponse: any = { content: [{ type: "image", data: "b64", mimeType: "image/png" }] };
    const result = stripToolResultStructuredContent(imageResponse, false);
    expect(result).toBe(imageResponse);
    expect("structuredContent" in result).toBe(false);
  });

  test("null / primitive responses pass through untouched", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    expect(stripToolResultStructuredContent(null, false)).toBeNull();
    expect(stripToolResultStructuredContent(undefined, false)).toBeUndefined();
    expect(stripToolResultStructuredContent("plain", false)).toBe("plain");
    expect(stripToolResultStructuredContent(42, false)).toBe(42);
  });
});
