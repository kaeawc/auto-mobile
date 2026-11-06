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
  webScreenshotOutputPath,
} from "./webScreenshotCases";

// The browser check itself is opt-in (webScreenshots.integration.test.ts); this keeps its
// committed goldens in step with the case list without launching a browser.
const cases = webScreenshotCases();

describe("prototype web screenshot goldens (#16346)", () => {
  test("every case has a fixture and viewport-sized portrait and landscape goldens", () => {
    // Fourteen specs in two frames, plus the largest text and RTL settings in both (#16552).
    expect(cases.length).toBe(32);
    for (const entry of cases) {
      expect(existsSync(entry.fixture)).toBe(true);
      expect(pngSize(readFileSync(entry.golden))).toEqual(WEB_SCREENSHOT_VIEWPORT);
      expect(pngSize(readFileSync(entry.landscapeGolden))).toEqual(WEB_SCREENSHOT_VIEWPORT);
    }
  });

  test("the golden directory holds no golden without a case", () => {
    const expected = cases
      .flatMap((entry) => [basename(entry.golden), basename(entry.landscapeGolden)])
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
