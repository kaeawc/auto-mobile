import { describe, expect, test } from "bun:test";
import { stringifyToolResponse, withIsErrorOnFailure } from "../../src/utils/toolUtils";

/**
 * Compact (non-pretty) JSON is now the unconditional default for serialized tool
 * results: no 2-space pretty-printing. Same data (parses back identically), fewer
 * characters — pretty-printing was ~35% of an element-heavy observe payload and
 * carries no meaning for the model. The former `--tool-results-compact-json`
 * toggle is retired; this is always on.
 */
describe("stringifyToolResponse compact-json default", () => {
  const sample = {
    screenSize: { width: 1080, height: 2400 },
    elements: { clickable: [{ "view-id": "a", bounds: { left: 0, top: 0, right: 1, bottom: 1 } }] },
  };

  test("single line, no indentation, but same data", () => {
    const out = stringifyToolResponse(sample);
    expect(out).not.toContain("\n");
    expect(out).not.toContain("  ");
    expect(JSON.parse(out)).toEqual(sample);
  });

  test("compact form is smaller than an equivalent pretty-print of the same data", () => {
    const compact = stringifyToolResponse(sample);
    const pretty = JSON.stringify(sample, null, 2);
    expect(compact.length).toBeLessThan(pretty.length);
  });
});

describe("withIsErrorOnFailure", () => {
  test("success returns the same envelope without isError", () => {
    const response = { content: [{ type: "text" as const, text: '{"success":true}' }] };
    const result = withIsErrorOnFailure(response, true);
    expect(result).toBe(response);
    expect(result.isError).toBeUndefined();
    expect(result).not.toHaveProperty("isError");
  });

  test("failure adds isError without changing or mutating the payload", () => {
    const payload = { success: false, error: "operation failed" };
    const response = {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
    const result = withIsErrorOnFailure(response, false);
    expect(result).toEqual({ ...response, isError: true });
    expect(result.content).toBe(response.content);
    expect(result.structuredContent).toBe(payload);
    expect(response).not.toHaveProperty("isError");
  });
});
