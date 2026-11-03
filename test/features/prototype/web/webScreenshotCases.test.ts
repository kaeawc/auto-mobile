import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  pngSize,
  WEB_SCREENSHOT_GOLDEN_DIR,
  WEB_SCREENSHOT_VIEWPORT,
  webScreenshotCases,
} from "./webScreenshotCases";

// The browser check itself is opt-in (webScreenshots.integration.test.ts); this keeps its
// committed goldens in step with the case list without launching a browser.
const cases = webScreenshotCases();

describe("prototype web screenshot goldens (#16346)", () => {
  test("every case has a fixture and a viewport-sized golden", () => {
    expect(cases.length).toBe(18);
    for (const entry of cases) {
      expect(existsSync(entry.fixture)).toBe(true);
      expect(pngSize(readFileSync(entry.golden))).toEqual(WEB_SCREENSHOT_VIEWPORT);
    }
  });

  test("the golden directory holds no golden without a case", () => {
    const expected = cases.map((entry) => basename(entry.golden)).sort();
    expect(readdirSync(WEB_SCREENSHOT_GOLDEN_DIR).sort()).toEqual(expected);
  });

  test("pngSize rejects bytes that are not a PNG", () => {
    expect(() => pngSize(Buffer.from("not a png at all, really"))).toThrow("not a PNG");
  });
});
