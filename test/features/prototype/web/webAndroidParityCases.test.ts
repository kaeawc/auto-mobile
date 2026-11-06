import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANDROID_GOLDEN_DIR,
  ANDROID_PARITY_CASES,
  ANDROID_PARITY_SKIPS,
  ANDROID_PARITY_VIEWPORT,
  androidParityFixturePath,
  androidParityHtml,
  androidParitySpec,
  contentOnly,
  parityAllowance,
  readAndroidParityBudgets,
} from "./webAndroidParityCases";
import { pngSize } from "./webScreenshotCases";

// The browser comparison is opt-in (webAndroidParity.integration.test.ts); this keeps its case
// table and budgets in step with the Android golden directory without launching a browser.
const goldens = readdirSync(ANDROID_GOLDEN_DIR)
  .filter((file) => file.endsWith(".png"))
  .map((file) => file.slice(0, -".png".length))
  .sort();
const covered = ANDROID_PARITY_CASES.map((entry) => entry.golden);
const skipped = ANDROID_PARITY_SKIPS.map((entry) => entry.golden);
const budgets = readAndroidParityBudgets();

describe("prototype web parity with the Android goldens (#16534)", () => {
  test("every Android golden is covered or skipped with a reason, exactly once", () => {
    expect([...covered, ...skipped].sort()).toEqual(goldens);
    expect(ANDROID_PARITY_SKIPS.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  test("the budget table has one non-negative pixel count per covered golden", () => {
    expect(Object.keys(budgets).sort()).toEqual([...covered].sort());
    for (const [golden, pixels] of Object.entries(budgets)) {
      expect({ golden, ok: Number.isInteger(pixels) && pixels >= 0 }).toEqual({ golden, ok: true });
    }
  });

  test("every covered golden fits the parity screen from its top-left", () => {
    for (const golden of covered) {
      const size = pngSize(readFileSync(join(ANDROID_GOLDEN_DIR, `${golden}.png`)));
      expect(size.width).toBeLessThanOrEqual(ANDROID_PARITY_VIEWPORT.width);
      expect(size.height).toBeLessThanOrEqual(ANDROID_PARITY_VIEWPORT.height);
    }
  });

  test("every case's fixtures exist", () => {
    for (const entry of ANDROID_PARITY_CASES) {
      expect(existsSync(androidParityFixturePath(entry.fixture))).toBe(true);
      if (entry.themeFrom) {
        expect(existsSync(androidParityFixturePath(entry.themeFrom))).toBe(true);
      }
    }
  });

  test("state overrides replace declared keys and refuse undeclared ones", () => {
    const open = ANDROID_PARITY_CASES.find((entry) => entry.golden === "bottom_sheet_open_light")!;
    expect((androidParitySpec(open).state as Record<string, unknown>).open).toBe(true);
    expect(() => androidParitySpec({ ...open, state: { nope: true } })).toThrow("nope");
  });

  test("themeFrom takes the other fixture's theme", () => {
    const entry = ANDROID_PARITY_CASES.find((c) => c.golden === "theme_seed_controls")!;
    const seed = JSON.parse(readFileSync(androidParityFixturePath("theme-seed"), "utf8"));
    expect(androidParitySpec(entry).theme).toEqual(seed.theme);
  });

  test("the role-scrim case keeps one sheet, opened at half", () => {
    const entry = ANDROID_PARITY_CASES.find(
      (c) => c.golden === "theme_modes_colors_role_scrim_open_light",
    )!;
    const original = JSON.parse(
      readFileSync(androidParityFixturePath("theme-modes-colors"), "utf8"),
    );
    const children = (
      androidParitySpec(entry).root as { children: { type: string; detents?: string[] }[] }
    ).children;
    expect(children.length).toBe(original.root.children.length - 1);
    const sheets = children.filter((child) => child.type === "bottomSheet");
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.every((sheet) => sheet.detents?.join() === "half")).toBe(true);
  });

  test("a sheet spec is compared fullscreen, as the content path draws it", () => {
    const entry = ANDROID_PARITY_CASES.find((c) => c.golden === "doc_example_2")!;
    const spec = androidParitySpec(entry);
    expect((spec.window as { placement: { type: string } }).placement.type).toBe("sheet");
    const window = contentOnly(spec).window as Record<string, unknown>;
    expect(window.placement).toEqual({ type: "fullscreen" });
    expect(androidParityHtml(entry)).toContain('data-window="fullscreen"');
    expect(androidParityHtml(entry)).not.toContain('data-window="sheet"');
  });

  test("the runner allowance is 256 pixels or 1% of the budget, below the golden's pixel count", () => {
    const screen = 360 * 640;
    expect(parityAllowance(0, screen)).toBe(256);
    expect(parityAllowance(1675, screen)).toBe(1675 + 256);
    expect(parityAllowance(69_282, screen)).toBe(69_282 + 693);
    // A budget near the whole screen still fails a screenshot that differs everywhere.
    expect(parityAllowance(229_179, screen)).toBe(screen - 1);
  });

  test("every budget leaves some pixels that must match", () => {
    for (const [golden, pixels] of Object.entries(budgets)) {
      const { width, height } = pngSize(readFileSync(join(ANDROID_GOLDEN_DIR, `${golden}.png`)));
      expect({ golden, below: pixels < width * height }).toEqual({ golden, below: true });
    }
  });

  test("icons draw the production Material glyphs, not placeholders", () => {
    const entry = ANDROID_PARITY_CASES.find((c) => c.golden === "fullscreen_all_nodes")!;
    expect(androidParityHtml(entry)).toContain("<svg");
  });

  test("the page is the chromeless still alone, transparent and inset-free", () => {
    const html = androidParityHtml(ANDROID_PARITY_CASES[0]!);
    expect(html).toContain('data-chrome="screen"');
    expect(html).not.toContain('data-chrome="frame"');
    expect(html).not.toContain("<script");
    expect(html).toContain("background-color:transparent");
    expect(html).toContain("--safe-top:0px");
  });
});
