import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANDROID_PARITY_CASES,
  ANDROID_PARITY_SKIPS,
  androidParityFixturePath,
} from "./webAndroidParityCases";
import {
  IOS_GOLDEN_DIR,
  IOS_PARITY_CASES,
  IOS_PARITY_SKIPS,
  IOS_PARITY_VIEWPORT,
  IOS_PARITY_SCALE,
  IOS_PARITY_TOP_PT,
  IOS_PARITY_BOTTOM_PT,
  IOS_PARITY_CLIP,
  IOS_PARITY_WIDTH,
  IOS_PARITY_HEIGHT,
  IOS_PARITY_CROP_TOP_PX,
  IOS_PARITY_FONT_CSS,
  iosParityHtml,
  parityAllowance,
  readIosParityBudgets,
} from "./webIosParityCases";
import { pngSize } from "./webScreenshotCases";

const goldens = existsSync(IOS_GOLDEN_DIR)
  ? readdirSync(IOS_GOLDEN_DIR)
      .filter((file) => file.endsWith(".png"))
      .map((file) => file.slice(0, -4))
      .sort()
  : [];
const covered = IOS_PARITY_CASES.map((entry) => entry.golden);
const skipped = IOS_PARITY_SKIPS.map((entry) => entry.golden);
const budgets = readIosParityBudgets();

describe("prototype web parity with the iOS viewer goldens (#16535)", () => {
  test("every iOS golden is covered or skipped exactly once and all covered goldens exist", () => {
    expect(goldens.filter((name) => !skipped.includes(name))).toEqual([...covered].sort());
    for (const name of goldens) {
      expect([...covered, ...skipped].filter((item) => item === name)).toHaveLength(1);
    }
  });

  test("every recorded golden has the cropped iPhone 16 size", () => {
    expect(goldens.length).toBeGreaterThan(0);
    for (const name of goldens) {
      expect(pngSize(readFileSync(join(IOS_GOLDEN_DIR, `${name}.png`)))).toEqual({
        width: 1179,
        height: 2556,
      });
    }
  });

  test("budget keys equal covered goldens in the directory", () => {
    expect(Object.keys(budgets).sort()).toEqual([...covered].sort());
    expect(Object.keys(budgets).sort()).toEqual(goldens.filter((name) => covered.includes(name)));
  });

  test("budgets are non-negative integers below the golden pixel count", () => {
    for (const pixels of Object.values(budgets)) {
      expect(
        Number.isInteger(pixels) && pixels >= 0 && pixels < IOS_PARITY_WIDTH * IOS_PARITY_HEIGHT,
      ).toBe(true);
    }
  });

  test("the Android set is reused with reasoned, unique skips", () => {
    const names = [...covered, ...skipped];
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(
      [...ANDROID_PARITY_CASES, ...ANDROID_PARITY_SKIPS].map((entry) => entry.golden).sort(),
    );
    expect(IOS_PARITY_SKIPS.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  test("all case fixtures exist", () => {
    for (const entry of IOS_PARITY_CASES) {
      expect(existsSync(androidParityFixturePath(entry.fixture))).toBe(true);
      if (entry.themeFrom) {
        expect(existsSync(androidParityFixturePath(entry.themeFrom))).toBe(true);
      }
    }
  });

  test("crop constants agree in points and physical pixels", () => {
    expect(IOS_PARITY_VIEWPORT).toEqual({ width: 393, height: 852 });
    expect(IOS_PARITY_SCALE).toBe(3);
    expect(IOS_PARITY_TOP_PT).toBe(0);
    expect(IOS_PARITY_BOTTOM_PT).toBe(0);
    expect(IOS_PARITY_CLIP).toEqual({ x: 0, y: 0, width: 393, height: 852 });
    expect([IOS_PARITY_WIDTH, IOS_PARITY_HEIGHT, IOS_PARITY_CROP_TOP_PX]).toEqual([1179, 2556, 0]);
    expect(IOS_PARITY_HEIGHT).toBe(852 * 3);
  });

  test("runner allowance uses the shared policy and cannot allow a wholly different screen", () => {
    const pixels = IOS_PARITY_WIDTH * IOS_PARITY_HEIGHT;
    expect(parityAllowance(0, pixels)).toBe(256);
    expect(parityAllowance(69_282, pixels)).toBe(69_975);
    expect(parityAllowance(pixels - 1, pixels)).toBe(pixels - 1);
  });

  test("HTML is bare with iOS chrome, safe areas and native switch metrics", () => {
    const entry = IOS_PARITY_CASES.find((item) => item.golden === "material_controls")!;
    const html = iosParityHtml(entry);
    expect(html).toContain('data-frame="iphone-16"');
    expect(html).toContain('data-nav="homeIndicator"');
    expect(html).toContain('data-part="track"');
    expect(html).toContain("width:51px");
    expect(html).toContain("--safe-top:59px");
    expect(html).toContain("--safe-bottom:34px");
    expect(html).toContain("html,body{margin:0}");
    expect(html).toContain(
      "padding:0!important;background:transparent!important;border-radius:0!important",
    );
    expect(html).toContain('[data-chrome="screen"]{border-radius:0!important}');
    expect(html).toContain('data-window="fullscreen"');
    expect(html).not.toContain("<script");
  });

  test("font pinning keeps authored families", () => {
    expect(IOS_PARITY_FONT_CSS).not.toContain("*{font-family");
    expect(IOS_PARITY_FONT_CSS).toContain('[data-chrome="screen"]{font-family:');
    expect(IOS_PARITY_FONT_CSS).toContain("caret-color:transparent");
    const entry = IOS_PARITY_CASES.find(
      (item) => item.golden === "theme_typography_shapes_slider_chip_card",
    )!;
    expect(
      iosParityHtml({
        ...entry,
        edit: (spec) => ({
          ...spec,
          root: { type: "text", text: "Authored serif", style: { fontFamily: "serif" } },
        }),
      }),
    ).toContain("font-family:serif");
  });
});
