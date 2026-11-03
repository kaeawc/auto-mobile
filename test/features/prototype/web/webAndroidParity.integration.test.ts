import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { diffPngs } from "../../../../src/features/visual/VisualDiff";
import {
  ANDROID_GOLDEN_DIR,
  ANDROID_PARITY_BUDGETS,
  ANDROID_PARITY_CASES,
  ANDROID_PARITY_VIEWPORT,
  androidParityHtml,
  parityAllowance,
  readAndroidParityBudgets,
} from "./webAndroidParityCases";
import { pngSize, WEB_SCREENSHOT_FONT_CSS } from "./webScreenshotCases";

/**
 * The web still, chromeless, against the Android renderer's goldens (#16534). Opt-in like the
 * page check beside it: it runs only through `bash scripts/prototype/web-screenshots.sh` and the
 * advisory `Prototype Web Screenshots` workflow. Each case may differ in at most its budget of
 * pixels; `--update` lowers budgets to what was measured and records missing ones, and raises one
 * only with `--allow-grow`.
 */
const RUN = process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS === "1";
const UPDATE = process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_UPDATE === "1";
const ALLOW_GROW = process.env.AUTOMOBILE_PROTOTYPE_WEB_PARITY_ALLOW_GROW === "1";
const OUT_DIR = join(
  process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT ??
    join(import.meta.dir, "../../../../scratch/prototype-web-screenshots"),
  "android-parity",
);
const describeBrowser = RUN ? describe : describe.skip;

const PAGE_URL = "http://prototype-web.test/";
/** pixelmatch's per-pixel colour distance; the budget counts the pixels beyond it. */
const PER_PIXEL_DELTA = 0.1;
const CASE_TIMEOUT_MS = 30_000;

function writeOutput(name: string, png: Buffer): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), png);
}

/** Budgets after an update: lower or new entries always, higher ones only with ALLOW_GROW. */
function updatedBudgets(
  budgets: Record<string, number>,
  measured: Record<string, number>,
): Record<string, number> {
  const next = Object.fromEntries(
    Object.entries(measured).map(([golden, pixels]) => {
      const budget = budgets[golden];
      return [golden, budget === undefined || ALLOW_GROW ? pixels : Math.min(budget, pixels)];
    }),
  );
  return Object.fromEntries(
    Object.entries({ ...budgets, ...next }).sort(([a], [b]) => a.localeCompare(b)),
  );
}

describeBrowser("prototype web still against the Android goldens (#16534)", () => {
  let browser: Browser;
  const budgets = readAndroidParityBudgets();
  const measured: Record<string, number> = {};

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    // A summary line per run, so CI logs carry every count for adopting a lower budget.
    console.log(`android parity diff pixels: ${JSON.stringify(measured)}`);
    if (UPDATE) {
      writeFileSync(
        ANDROID_PARITY_BUDGETS,
        `${JSON.stringify(updatedBudgets(budgets, measured), null, 2)}\n`,
      );
    }
  });

  for (const entry of ANDROID_PARITY_CASES) {
    test(
      entry.golden,
      async () => {
        const goldenPath = join(ANDROID_GOLDEN_DIR, `${entry.golden}.png`);
        expect(existsSync(goldenPath)).toBe(true);
        const golden = readFileSync(goldenPath);
        // A content-sized golden is the top-left of the screen the content laid out on.
        const clip = { x: 0, y: 0, ...pngSize(golden) };
        const page = await browser.newPage({
          viewport: ANDROID_PARITY_VIEWPORT,
          deviceScaleFactor: 1,
        });
        const requests: string[] = [];
        try {
          await page.route("**/*", async (route) => {
            const url = route.request().url();
            if (url === PAGE_URL) {
              await route.fulfill({
                contentType: "text/html; charset=utf-8",
                body: androidParityHtml(entry),
              });
              return;
            }
            requests.push(url);
            await route.abort("blockedbyclient");
          });
          await page.goto(PAGE_URL, { waitUntil: "load" });
          await page.addStyleTag({ content: WEB_SCREENSHOT_FONT_CSS });
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          const actual = await page.screenshot({
            animations: "disabled",
            caret: "hide",
            clip,
            // The goldens are transparent where the content draws nothing.
            omitBackground: true,
          });
          writeOutput(`${entry.golden}.png`, actual);
          expect(requests).toEqual([]);

          const result = diffPngs(golden, actual, {
            perPixelDelta: PER_PIXEL_DELTA,
            pixelRatio: 0,
          });
          if (result === "size_mismatch") {
            throw new Error(`${entry.golden}: screenshot size differs from the golden`);
          }
          if (result.diffPng) {
            writeOutput(`${entry.golden}.diff.png`, result.diffPng);
          }
          measured[entry.golden] = result.diffPixels;
          const budget = budgets[entry.golden];
          if (!UPDATE) {
            if (budget === undefined) {
              throw new Error(`${entry.golden}: no budget; record one with --update`);
            }
            expect(result.diffPixels).toBeLessThanOrEqual(
              parityAllowance(budget, clip.width * clip.height),
            );
          }
        } finally {
          await page.close();
        }
      },
      CASE_TIMEOUT_MS,
    );
  }
});
