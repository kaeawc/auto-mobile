import { describe, expect, test } from "bun:test";
import { stringifyToolResponse } from "../../src/utils/toolUtils";

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
