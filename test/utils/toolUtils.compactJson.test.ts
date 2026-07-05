import { afterEach, describe, expect, test } from "bun:test";
import { serverConfig } from "../../src/utils/ServerConfig";
import { stringifyToolResponse } from "../../src/utils/toolUtils";

/**
 * --tool-results-compact-json drops the 2-space pretty-printing from serialized
 * tool results. Same data (parses back identically), fewer characters — pretty-
 * printing is ~35% of an element-heavy observe payload and carries no meaning for
 * the model. Default off, so behavior is unchanged unless the flag is set.
 */
describe("stringifyToolResponse compact-json flag", () => {
  const sample = {
    screenSize: { width: 1080, height: 2400 },
    elements: { clickable: [{ "view-id": "a", "bounds": { left: 0, top: 0, right: 1, bottom: 1 } }] },
  };

  afterEach(() => {
    serverConfig.setToolResultsCompactJsonEnabled(false);
  });

  test("default: pretty-printed (indented, multi-line)", () => {
    const out = stringifyToolResponse(sample);
    expect(out).toContain("\n");
    expect(out).toContain("  ");
  });

  test("compact: single line, no indentation, but same data", () => {
    serverConfig.setToolResultsCompactJsonEnabled(true);
    const out = stringifyToolResponse(sample);
    expect(out).not.toContain("\n");
    expect(JSON.parse(out)).toEqual(sample);
  });

  test("compact form is strictly smaller than pretty for element-heavy content", () => {
    const pretty = stringifyToolResponse(sample);
    serverConfig.setToolResultsCompactJsonEnabled(true);
    const compact = stringifyToolResponse(sample);
    expect(compact.length).toBeLessThan(pretty.length);
  });
});
