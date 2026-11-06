import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  pngSize,
  WEB_SCREENSHOT_ENGINES,
  WEB_SCREENSHOT_GOLDEN_DIR,
  WEB_SCREENSHOT_VIEWPORT,
  webScreenshotCases,
  webScreenshotEngines,
  webScreenshotGoldens,
  webScreenshotOutputPath,
} from "./webScreenshotCases";

// The browser check itself is opt-in (webScreenshots.integration.test.ts); this keeps its
// committed goldens in step with the case list without launching a browser.
const cases = webScreenshotCases();

describe("prototype web screenshot goldens (#16346)", () => {
  test("every case has a fixture and a viewport-sized golden per orientation", () => {
    // Fourteen specs in two frames, the largest text and RTL settings in both (#16552), and one
    // spec in each watch, TV and car frame (#16446).
    expect(cases.length).toBe(37);
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

  test("settings cases name their setting and render at the largest text size or in RTL", () => {
    const settings = Object.fromEntries(
      cases.filter((entry) => entry.settings).map((entry) => [entry.name, entry.settings]),
    );
    expect(settings).toEqual({
      "reference-checkout--pixel-9--largest-text": { textSize: { fontScale: 2 } },
      "reference-checkout--iphone-16--largest-text": {
        textSize: { contentSize: "accessibility-extra-extra-extra-large" },
      },
      "reference-checkout--pixel-9--rtl": { locale: "ar" },
      "reference-checkout--iphone-16--rtl": { locale: "ar" },
    });
  });

  test("pngSize rejects bytes that are not a PNG", () => {
    expect(() => pngSize(Buffer.from("not a png at all, really"))).toThrow("not a PNG");
  });
});

describe("prototype web screenshot engines (#16459)", () => {
  test("unset or blank selects every engine", () => {
    expect(webScreenshotEngines(undefined)).toEqual([...WEB_SCREENSHOT_ENGINES]);
    expect(webScreenshotEngines(" , ")).toEqual(["chromium", "firefox", "webkit"]);
  });

  test("a list selects those engines in canonical order without duplicates", () => {
    expect(webScreenshotEngines("webkit, chromium,webkit")).toEqual(["chromium", "webkit"]);
    expect(webScreenshotEngines("firefox")).toEqual(["firefox"]);
  });

  test("an unknown engine name throws", () => {
    expect(() => webScreenshotEngines("chromium,safari")).toThrow(
      "unknown browser engine(s): safari",
    );
  });

  test("only the golden engine writes to the top level of the output directory", () => {
    expect(webScreenshotOutputPath("chromium", "a.png")).toBe("a.png");
    expect(webScreenshotOutputPath("webkit", "a.png")).toBe(join("webkit", "a.png"));
    expect(webScreenshotOutputPath("firefox", "a.png")).toBe(join("firefox", "a.png"));
  });
});
