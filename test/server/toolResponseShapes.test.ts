import { describe, expect, test } from "bun:test";
import { isToolResponseFailure } from "../../src/server/pipeline/afterToolCall";
import { markToolFailure } from "../../src/utils/toolFailureSignal";
import {
  createImageToolResponse,
  createJSONToolResponse,
  createStructuredToolResponse,
  observationOfPayload,
} from "../../src/utils/toolUtils";

/**
 * Pins the response shapes the pipeline classifies today (#11830), before the envelope is
 * converged: the failure verdict never parses JSON text, and the observation lives at the
 * top level for `observe` and under `.observation` for every other tool.
 */
describe("createJSONToolResponse wire shape", () => {
  test("is a single text block with no structuredContent", () => {
    const response = createJSONToolResponse({ success: true, value: 1 });
    expect(Object.keys(response).sort()).toEqual(["content"]);
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe("text");
    expect(JSON.parse(response.content[0].text)).toEqual({ success: true, value: 1 });
  });
});

describe("createStructuredToolResponse wire shape", () => {
  test("hoists only success and error next to content and structuredContent", () => {
    const response = createStructuredToolResponse({
      success: false,
      error: "boom",
      found: true,
    });
    expect(Object.keys(response).sort()).toEqual([
      "content",
      "error",
      "structuredContent",
      "success",
    ]);
    expect(response.structuredContent).toEqual({ success: false, error: "boom", found: true });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });

  test("a payload without success or error hoists nothing", () => {
    const response = createStructuredToolResponse({ found: true });
    expect(Object.keys(response).sort()).toEqual(["content", "structuredContent"]);
  });
});

describe("createImageToolResponse wire shape", () => {
  test("is a single image block", () => {
    const response = createImageToolResponse("QUJD", "image/png");
    expect(response.content).toEqual([{ type: "image", data: "QUJD", mimeType: "image/png" }]);
  });
});

describe("isToolResponseFailure", () => {
  test("isError wins over a success flag", () => {
    expect(isToolResponseFailure({ isError: true, success: true })).toBe(true);
  });

  test("top-level success:false is a failure, success:true is not", () => {
    expect(isToolResponseFailure({ success: false })).toBe(true);
    expect(isToolResponseFailure({ success: true })).toBe(false);
  });

  test("structuredContent.success decides when the top level says nothing", () => {
    expect(isToolResponseFailure({ structuredContent: { success: false } })).toBe(true);
    expect(isToolResponseFailure({ structuredContent: { success: true } })).toBe(false);
  });

  test("an explicit structured success:true beats the out-of-band failure mark", () => {
    const response = markToolFailure({ structuredContent: { success: true } });
    expect(isToolResponseFailure(response)).toBe(false);
  });

  test("a top-level success:true beats the out-of-band failure mark", () => {
    expect(isToolResponseFailure(markToolFailure({ success: true }))).toBe(false);
  });

  test("the failure mark classifies an envelope with no explicit status", () => {
    expect(isToolResponseFailure(markToolFailure({ content: [] }))).toBe(true);
    expect(isToolResponseFailure({ content: [] })).toBe(false);
  });

  test("a JSON-text response with success:false is marked out of band, not by parsing its text", () => {
    const failed = createJSONToolResponse({ success: false, error: "boom" });
    expect(Object.keys(failed)).toEqual(["content"]);
    expect(isToolResponseFailure(failed)).toBe(true);
    // A shallow copy sharing the content array keeps the mark; the same text in a fresh
    // content array does not.
    expect(isToolResponseFailure({ content: failed.content })).toBe(true);
    expect(isToolResponseFailure({ content: [{ ...failed.content[0] }] })).toBe(false);
    expect(isToolResponseFailure(createJSONToolResponse({ success: true }))).toBe(false);
  });

  test("non-records are not failures", () => {
    expect(isToolResponseFailure(undefined)).toBe(false);
    expect(isToolResponseFailure(null)).toBe(false);
    expect(isToolResponseFailure("error")).toBe(false);
    expect(isToolResponseFailure([{ isError: true }])).toBe(false);
  });
});

describe("observationOfPayload", () => {
  const observation = { viewHierarchy: { hierarchy: {} } };

  test("observe returns its payload as the observation", () => {
    const payload = { ...observation };
    expect(observationOfPayload("observe", payload)).toBe(payload);
  });

  test("action tools nest the observation", () => {
    expect(observationOfPayload("tapOn", { observation })).toBe(observation);
  });

  test("an action tool without an observation yields undefined", () => {
    expect(observationOfPayload("tapOn", { success: true })).toBeUndefined();
  });
});
