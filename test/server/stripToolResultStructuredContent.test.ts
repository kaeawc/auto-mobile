import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stripToolResultStructuredContent } from "../../src/server/stripToolResultStructuredContent";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";

/**
 * Wire-boundary strip for the `--tool-results-no-structured-content` flag
 * (issue #2899). `content[0].text` and `structuredContent` are byte-identical
 * duplicates, so dropping the latter halves the wire payload with no data loss.
 */
describe("stripToolResultStructuredContent", () => {
  let original: boolean;

  beforeEach(() => {
    original = serverConfig.isToolResultsNoStructuredContentEnabled();
  });

  afterEach(() => {
    serverConfig.setToolResultsNoStructuredContentEnabled(original);
  });

  test("EC-A: drops structuredContent when the gate is enabled, keeps content text", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const payload = { success: true, message: "done", nested: { a: 1 } };
    const response = stripToolResultStructuredContent(createStructuredToolResponse(payload));

    expect("structuredContent" in response).toBe(false);
    expect(response.content[0].type).toBe("text");
    // Full payload is still recoverable from the retained text — no data loss.
    expect(JSON.parse(response.content[0].text)).toEqual(payload);
  });

  test("EC-B: preserves structuredContent when the gate is disabled", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    const response = stripToolResultStructuredContent(createStructuredToolResponse({ success: true }));
    expect(response.structuredContent).toEqual({ success: true });
  });

  test("EC-D: strips regardless of payload shape (covers plain-registered tools)", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    // e.g. exportPlan/recordSteps: declare an outputSchema, bypass finalizeToolResponse.
    const response = stripToolResultStructuredContent(
      createStructuredToolResponse({ success: true, plan: "steps:\n  - tapOn: {}" })
    );
    expect("structuredContent" in response).toBe(false);
    expect(JSON.parse(response.content[0].text).plan).toBe("steps:\n  - tapOn: {}");
  });

  test("EC-E: response without structuredContent is an unchanged no-op", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const imageResponse: any = { content: [{ type: "image", data: "b64", mimeType: "image/png" }] };
    const result = stripToolResultStructuredContent(imageResponse);
    expect(result).toBe(imageResponse);
    expect("structuredContent" in result).toBe(false);
  });

  test("null / primitive responses pass through untouched", () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    expect(stripToolResultStructuredContent(null)).toBeNull();
    expect(stripToolResultStructuredContent(undefined)).toBeUndefined();
    expect(stripToolResultStructuredContent("plain")).toBe("plain");
    expect(stripToolResultStructuredContent(42)).toBe(42);
  });
});
