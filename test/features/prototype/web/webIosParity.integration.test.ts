import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { diffPngs } from "../../../../src/features/visual/VisualDiff";
import {
  IOS_GOLDEN_DIR,
  IOS_PARITY_BUDGETS,
  IOS_PARITY_CASES,
  IOS_PARITY_FONT_CSS,
  IOS_PARITY_VIEWPORT,
  IOS_PARITY_SCALE,
  IOS_PARITY_CLIP,
  IOS_PARITY_IGNORE,
  IOS_PARITY_WIDTH,
  IOS_PARITY_HEIGHT,
  iosParityHtml,
  parityAllowance,
  readIosParityBudgets,
} from "./webIosParityCases";
import { pngSize } from "./webScreenshotCases";

/**
 * The web still in the iOS skin, against the iOS renderer's goldens (#16535). Opt-in like the
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
  "ios-parity",
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

describeBrowser("prototype web still against the iOS goldens (#16535)", () => {
  let browser: Browser;
  const budgets = readIosParityBudgets();
  const measured: Record<string, number> = {};

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    // A summary line per run, so CI logs carry every count for adopting a lower budget.
    console.log(`ios parity diff pixels: ${JSON.stringify(measured)}`);
    if (UPDATE) {
      writeFileSync(
        IOS_PARITY_BUDGETS,
        `${JSON.stringify(updatedBudgets(budgets, measured), null, 2)}\n`,
      );
    }
  });

  for (const entry of IOS_PARITY_CASES) {
    test(
      entry.golden,
      async () => {
        const goldenPath = join(IOS_GOLDEN_DIR, `${entry.golden}.png`);
        expect(existsSync(goldenPath)).toBe(true);
        const golden = readFileSync(goldenPath);
        expect(pngSize(golden)).toEqual({ width: IOS_PARITY_WIDTH, height: IOS_PARITY_HEIGHT });
        const clip = IOS_PARITY_CLIP;
        const page = await browser.newPage({
          viewport: IOS_PARITY_VIEWPORT,
          deviceScaleFactor: IOS_PARITY_SCALE,
        });
        const requests: string[] = [];
        try {
          await page.route("**/*", async (route) => {
            const url = route.request().url();
            if (url === PAGE_URL) {
              await route.fulfill({
                contentType: "text/html; charset=utf-8",
                body: iosParityHtml(entry),
              });
              return;
            }
            requests.push(url);
            await route.abort("blockedbyclient");
          });
          await page.goto(PAGE_URL, { waitUntil: "load" });
          await page.addStyleTag({ content: IOS_PARITY_FONT_CSS });
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          const actual = await page.screenshot({
            animations: "disabled",
            caret: "hide",
            clip,
          });
          writeOutput(`${entry.golden}.png`, actual);
          expect(requests).toEqual([]);

          const result = diffPngs(golden, actual, {
            perPixelDelta: PER_PIXEL_DELTA,
            pixelRatio: 0,
            ignore: IOS_PARITY_IGNORE,
          });
          if (result === "size_mismatch") {
            throw new Error(`${entry.golden}: screenshot size differs from the golden`);
          }
          if (result.diffPng) {
            writeOutput(`${entry.golden}.diff.png`, result.diffPng);
          }
          measured[entry.golden] = result.diffPixels;
          const budget = budgets[entry.golden];
          if (budget === undefined && !UPDATE) {
            throw new Error(`${entry.golden}: no budget; record one with --update`);
          }
          // An update keeps a budget it may not raise, so it still fails a case over that budget.
          if (budget !== undefined && !(UPDATE && ALLOW_GROW)) {
            expect(result.diffPixels).toBeLessThanOrEqual(
              parityAllowance(budget, IOS_PARITY_WIDTH * IOS_PARITY_HEIGHT),
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
