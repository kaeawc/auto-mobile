import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  pngSize,
  WEB_SCREENSHOT_GOLDEN_DIR,
  WEB_SCREENSHOT_VIEWPORT,
  webScreenshotCases,
  webScreenshotGoldens,
} from "./webScreenshotCases";

// The browser check itself is opt-in (webScreenshots.integration.test.ts); this keeps its
// committed goldens in step with the case list without launching a browser.
const cases = webScreenshotCases();

describe("prototype web screenshot goldens (#16346)", () => {
  test("every case has a fixture and a viewport-sized golden per orientation", () => {
    expect(cases.length).toBe(23);
    for (const entry of cases) {
      expect(existsSync(entry.fixture)).toBe(true);
      const goldens = webScreenshotGoldens(entry);
      expect(goldens.length).toBe(entry.orientations.length);
      for (const golden of goldens) {
        expect(pngSize(readFileSync(golden))).toEqual(WEB_SCREENSHOT_VIEWPORT);
      }
    }
  });

  test("one reference spec covers each watch, TV and car frame, in its only orientation (#16446)", () => {
    const single = cases.filter((entry) => entry.orientations.length === 1);
    expect(single.map((entry) => [entry.frame, entry.orientations[0]])).toEqual([
      ["wearos-small-round", "portrait"],
      ["apple-watch", "portrait"],
      ["android-tv-1080p", "landscape"],
      ["apple-tv", "landscape"],
      ["car-1024p-landscape", "landscape"],
    ]);
  });

  test("the golden directory holds no golden without a case", () => {
    const expected = cases
      .flatMap((entry) => webScreenshotGoldens(entry).map((golden) => basename(golden)))
      .sort();
    expect(readdirSync(WEB_SCREENSHOT_GOLDEN_DIR).sort()).toEqual(expected);
  });

  test("pngSize rejects bytes that are not a PNG", () => {
    expect(() => pngSize(Buffer.from("not a png at all, really"))).toThrow("not a PNG");
  });
});
