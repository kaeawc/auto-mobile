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
  webSpecPage,
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
/**
 * The page's status bar clock follows the browser clock (#16585); the check pins it to the stills'
 * 9:41, in UTC, so the goldens stay byte-stable.
 */
const STILL_TIME = "2026-01-01T09:41:00Z";
const TIMEZONE = "UTC";

interface PageProblems {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly requests: string[];
}

type ClockSetup = (page: Page) => Promise<void>;

const freezeClock: ClockSetup = (page) => page.clock.setFixedTime(STILL_TIME);

async function openPage(
  browser: Browser,
  html: string,
  clock: ClockSetup = freezeClock,
): Promise<{ page: Page } & PageProblems> {
  const page = await browser.newPage({
    viewport: WEB_SCREENSHOT_VIEWPORT,
    deviceScaleFactor: 1,
    timezoneId: TIMEZONE,
  });
  await clock(page);
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

interface MidRotation {
  readonly animations: number;
  /** The orientations of the views shown halfway through the turn. */
  readonly shown: string[];
  /** Each shown view's rotation in degrees, read from its computed transform. */
  readonly angles: number[];
}

/** Pauses the running turn halfway, so its frame can be inspected. */
function midRotation(page: Page): Promise<MidRotation> {
  return page.evaluate(() => {
    const animations = document.getAnimations();
    animations.forEach((animation) => {
      animation.pause();
      const duration = Number(animation.effect?.getTiming().duration ?? 0);
      animation.currentTime = duration / 2;
    });
    const shown = Array.from(document.querySelectorAll<HTMLElement>("[data-view]")).filter(
      (view) => !view.hidden,
    );
    return {
      animations: animations.length,
      shown: shown.map((view) => view.dataset.orientation ?? ""),
      angles: shown.map((view) => {
        const matrix = new DOMMatrix(getComputedStyle(view).transform);
        return (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
      }),
    };
  });
}

/** Finishes the turn and waits for its finish handler to hide the outgoing view. */
async function finishAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getAnimations().forEach((animation) => animation.finish());
  });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-view]")).filter(
        (view) => !view.hidden,
      ).length === 1,
  );
}

function writeOutput(name: string, png: Buffer): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), png);
}

/** Compares against a golden; a mismatch leaves `<name>.png` and `<name>.diff.png` in OUT_DIR. */
function compareToGolden(name: string, golden: string, actual: Buffer): string | undefined {
  if (UPDATE) {
    mkdirSync(WEB_SCREENSHOT_GOLDEN_DIR, { recursive: true });
    writeFileSync(golden, actual);
    return undefined;
  }
  if (!existsSync(golden)) {
    return `no golden at ${golden}`;
  }
  const result = diffPngs(readFileSync(golden), actual, {
    perPixelDelta: PER_PIXEL_DELTA,
    pixelRatio: PIXEL_RATIO,
  });
  if (result === "size_mismatch") {
    return "screenshot size differs from the golden";
  }
  if (!result.match) {
    if (result.diffPng) {
      writeOutput(`${name}.diff.png`, result.diffPng);
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

          // Mid-rotation (#16545): both views are shown and turned; then the turn ends upright.
          await page.click('[data-control="rotate"]');
          const turning = await midRotation(page);
          expect(turning.animations).toBe(3);
          expect(turning.shown.sort()).toEqual(["landscape", "portrait"]);
          expect(turning.angles.every((angle) => Math.abs(angle) > 1)).toBe(true);
          await finishAnimations(page);
          const rotated = await shownView(page);
          expect(rotated.count).toBe(1);
          expect(rotated.orientation).toBe("landscape");
          expect(rotated.width).toBeGreaterThan(rotated.height);
          const landscape = await page.screenshot({ animations: "disabled", caret: "hide" });
          writeOutput(`${entry.name}--landscape.png`, landscape);

          // Reduced motion skips the turn.
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.click('[data-control="rotate"]');
          expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
          expect((await shownView(page)).orientation).toBe("portrait");
          await page.emulateMedia({ reducedMotion: "no-preference" });

          // A multi-screen stack's picker shows exactly the picked screen's view.
          const screens = await page.$$eval(
            '[data-control="screen"]:not([hidden]) option',
            (options) => options.map((option) => (option as HTMLOptionElement).value),
          );
          if (screens.length > 1) {
            await page.selectOption('[data-control="screen"]', screens.at(-1)!);
            const picked = await page.evaluate(() =>
              Array.from(document.querySelectorAll<HTMLElement>("[data-view]"))
                .filter((view) => !view.hidden)
                .map((view) => view.dataset.screen),
            );
            expect(picked).toEqual([screens.at(-1)]);
          }

          const violations = await page.evaluate((): string[] =>
            Reflect.get(globalThis, "__cspViolations"),
          );
          expect({
            consoleErrors: problems.consoleErrors,
            pageErrors: problems.pageErrors,
            requests: problems.requests,
            violations,
          }).toEqual({ consoleErrors: [], pageErrors: [], requests: [], violations: [] });

          expect(compareToGolden(entry.name, entry.golden, screenshot)).toBeUndefined();
          expect(
            compareToGolden(`${entry.name}--landscape`, entry.landscapeGolden, landscape),
          ).toBeUndefined();
        } finally {
          await page.close();
        }
      },
      CASE_TIMEOUT_MS,
    );
  }

  test(
    "the status bar clock follows the browser clock (#16585)",
    async () => {
      const [entry] = webScreenshotCases();
      const { page } = await openPage(browser, webScreenshotPage(entry!), (opened) =>
        opened.clock.install({ time: "2026-01-01T13:07:30Z" }),
      );
      const clocks = () =>
        page.$$eval('[data-status="clock"]', (marks) =>
          Array.from(new Set(marks.map((mark) => mark.textContent))),
        );
      try {
        expect(await clocks()).toEqual(["1:07"]);
        await page.clock.runFor(30_000);
        expect(await clocks()).toEqual(["1:08"]);
        await page.clock.runFor(60_000);
        expect(await clocks()).toEqual(["1:09"]);
      } finally {
        await page.close();
      }
    },
    CASE_TIMEOUT_MS,
  );
});

const FADE_FIXTURE = join(
  import.meta.dir,
  "../../../fixtures/prototype-web/fade-edges-overflow.json",
);

describeBrowser("scroll fade edges follow overflow in headless Chromium (#16606)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  for (const direction of ["ltr", "rtl"] as const) {
    test(
      `only an overflowing scroll fades its trailing edge (${direction})`,
      async () => {
        const base = JSON.parse(readFileSync(FADE_FIXTURE, "utf8")) as Record<string, unknown>;
        const window = { ...(base.window as Record<string, unknown>), layoutDirection: direction };
        const { page } = await openPage(browser, webSpecPage({ ...base, window }, "fade-edges"));
        try {
          const masks = await page.evaluate(() =>
            Object.fromEntries(
              Array.from(
                document.querySelectorAll<HTMLElement>("[data-view]:not([hidden]) [data-fade]"),
              ).map((scroll) => [scroll.dataset.testid, getComputedStyle(scroll).maskImage]),
            ),
          );
          const trailing = direction === "rtl" ? "to right" : "to left";
          expect(masks["vertical-fits"]).toBe("none");
          expect(masks["horizontal-fits"]).toBe("none");
          expect(masks["vertical-overflows"]).toStartWith("linear-gradient(to top,");
          expect(masks["horizontal-overflows"]).toStartWith(`linear-gradient(${trailing},`);
        } finally {
          await page.close();
        }
      },
      CASE_TIMEOUT_MS,
    );
  }
});
