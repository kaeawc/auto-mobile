import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { diffPngs } from "../../../../src/features/visual/VisualDiff";
import {
  WEB_SCREENSHOT_FONT_CSS,
  WEB_SCREENSHOT_GOLDEN_DIR,
  WEB_SCREENSHOT_VIEWPORT,
  webScreenshotCases,
  webScreenshotPage,
  type WebScreenshotCase,
} from "./webScreenshotCases";

/**
 * Headless Chromium check of the prototype web page's reference specs (#16346). Opt-in: it
 * launches a browser, so it runs only through `bash scripts/prototype/web-screenshots.sh` and the
 * advisory `Prototype Web Screenshots` workflow. Playwright is a dev dependency of this check
 * only; nothing at runtime drives a browser.
 */
const RUN = process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS === "1";
const UPDATE = process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_UPDATE === "1";
const OUT_DIR =
  process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT ??
  join(import.meta.dir, "../../../../scratch/prototype-web-screenshots");
const describeBrowser = RUN ? describe : describe.skip;

/** The page is served from this origin; every other request is a leak and is aborted. */
const PAGE_URL = "http://prototype-web.test/";
/** pixelmatch's per-pixel colour distance, and the share of pixels that may still differ. */
const PER_PIXEL_DELTA = 0.1;
const PIXEL_RATIO = 0.001;
const CASE_TIMEOUT_MS = 30_000;

interface PageProblems {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly requests: string[];
}

async function openPage(browser: Browser, html: string): Promise<{ page: Page } & PageProblems> {
  const page = await browser.newPage({ viewport: WEB_SCREENSHOT_VIEWPORT, deviceScaleFactor: 1 });
  const problems: PageProblems = { consoleErrors: [], pageErrors: [], requests: [] };
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === PAGE_URL) {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
      return;
    }
    problems.requests.push(url);
    await route.abort("blockedbyclient");
  });
  // Injected by the browser before the page's own script, so the CSP does not govern it.
  await page.addInitScript(() => {
    const violations: string[] = [];
    Reflect.set(globalThis, "__cspViolations", violations);
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  await page.goto(PAGE_URL, { waitUntil: "load" });
  return { page, ...problems };
}

interface ShownView {
  readonly count: number;
  readonly orientation: string | undefined;
  readonly width: number;
  readonly height: number;
}

function shownView(page: Page): Promise<ShownView> {
  return page.evaluate(() => {
    const shown = Array.from(document.querySelectorAll<HTMLElement>("[data-view]")).filter(
      (view) => !view.hidden,
    );
    const box = shown[0]?.getBoundingClientRect();
    return {
      count: shown.length,
      orientation: shown[0]?.dataset.orientation,
      width: box?.width ?? 0,
      height: box?.height ?? 0,
    };
  });
}

function writeOutput(name: string, png: Buffer): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), png);
}

/** Compares against the golden; a mismatch leaves `<case>.png` and `<case>.diff.png` in OUT_DIR. */
function compareToGolden(entry: WebScreenshotCase, actual: Buffer): string | undefined {
  if (UPDATE) {
    mkdirSync(WEB_SCREENSHOT_GOLDEN_DIR, { recursive: true });
    writeFileSync(entry.golden, actual);
    return undefined;
  }
  if (!existsSync(entry.golden)) {
    return `no golden at ${entry.golden}`;
  }
  const result = diffPngs(readFileSync(entry.golden), actual, {
    perPixelDelta: PER_PIXEL_DELTA,
    pixelRatio: PIXEL_RATIO,
  });
  if (result === "size_mismatch") {
    return "screenshot size differs from the golden";
  }
  if (!result.match) {
    if (result.diffPng) {
      writeOutput(`${entry.name}.diff.png`, result.diffPng);
    }
    return `${(result.diffRatio * 100).toFixed(3)}% of pixels differ (limit ${PIXEL_RATIO * 100}%)`;
  }
  return undefined;
}

describeBrowser("prototype web page in headless Chromium (#16346)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  for (const entry of webScreenshotCases()) {
    test(
      entry.name,
      async () => {
        const { page, ...problems } = await openPage(browser, webScreenshotPage(entry));
        try {
          const first = await shownView(page);
          expect(first.count).toBe(1);
          expect(first.orientation).toBe("portrait");
          expect(first.width).toBeGreaterThan(0);
          expect(first.height).toBeGreaterThan(0);

          // The runtime ran: it fitted the stage and wrote that scale into the zoom label.
          const zoom = await page.evaluate(() => ({
            transform: document.querySelector<HTMLElement>("[data-stage]")?.style.transform ?? "",
            label: document.querySelector('[data-control="zoom-level"]')?.textContent ?? "",
          }));
          const scale = Number(/scale\(([\d.]+)\)/.exec(zoom.transform)?.[1]);
          expect(scale).toBeGreaterThan(0);
          expect(zoom.label).toBe(`${Math.round(scale * 100)}%`);

          await page.addStyleTag({ content: WEB_SCREENSHOT_FONT_CSS });
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          const screenshot = await page.screenshot({ animations: "disabled", caret: "hide" });
          // Saved before any assertion, so a case that fails a functional check keeps its image.
          writeOutput(`${entry.name}.png`, screenshot);

          await page.click('[data-control="rotate"]');
          const rotated = await shownView(page);
          expect(rotated.count).toBe(1);
          expect(rotated.orientation).toBe("landscape");
          expect(rotated.width).toBeGreaterThan(rotated.height);

          const violations = await page.evaluate((): string[] =>
            Reflect.get(globalThis, "__cspViolations"),
          );
          expect({
            consoleErrors: problems.consoleErrors,
            pageErrors: problems.pageErrors,
            requests: problems.requests,
            violations,
          }).toEqual({ consoleErrors: [], pageErrors: [], requests: [], violations: [] });

          expect(compareToGolden(entry, screenshot)).toBeUndefined();
        } finally {
          await page.close();
        }
      },
      CASE_TIMEOUT_MS,
    );
  }
});
