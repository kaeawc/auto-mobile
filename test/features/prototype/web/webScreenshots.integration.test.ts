import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserType,
  type Page,
} from "playwright-core";
import { toHtml } from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";
import { diffPngs } from "../../../../src/features/visual/VisualDiff";
import {
  WEB_SCREENSHOT_FONT_CSS,
  WEB_SCREENSHOT_GOLDEN_DIR,
  WEB_SCREENSHOT_VIEWPORT,
  WEB_SCREENSHOT_GOLDEN_ENGINE,
  webScreenshotCases,
  webScreenshotEngines,
  webScreenshotOutputPath,
  webScreenshotPage,
  webSpecPage,
  type WebScreenshotEngine,
} from "./webScreenshotCases";

/**
 * Headless browser check of the prototype web page's reference specs (#16346), in Chromium,
 * Firefox and WebKit (#16459); only Chromium is compared with the goldens. Opt-in: it launches
 * browsers, so it runs only through `bash scripts/prototype/web-screenshots.sh` and the advisory
 * `Prototype Web Screenshots` workflow. Playwright is a dev dependency of this check only; nothing
 * at runtime drives a browser.
 */
const RUN = process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS === "1";
const UPDATE = process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_UPDATE === "1";
const OUT_DIR =
  process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT ??
  join(import.meta.dir, "../../../../scratch/prototype-web-screenshots");
const ENGINES = webScreenshotEngines(process.env.AUTOMOBILE_PROTOTYPE_WEB_ENGINES);
const describeBrowser = RUN ? describe : describe.skip;
const BROWSER_TYPES: Readonly<Record<WebScreenshotEngine, BrowserType>> = {
  chromium,
  firefox,
  webkit,
};

/** The page is served from this origin; every other request is a leak and is aborted. */
const PAGE_URL = "http://prototype-web.test/";
/** pixelmatch's per-pixel colour distance, and the share of pixels that may still differ. */
const PER_PIXEL_DELTA = 0.1;
const PIXEL_RATIO = 0.001;
const CASE_TIMEOUT_MS = 30_000;
/** A cold browser start can exceed bun's 5 s default hook timeout. */
const LAUNCH_TIMEOUT_MS = 30_000;
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

interface Device3dState {
  readonly pressed: string | null;
  readonly wrapped: boolean;
  readonly transform: string;
}

function device3dState(page: Page): Promise<Device3dState> {
  return page.evaluate(() => {
    const orbit = document.querySelector<HTMLElement>("[data-orbit]");
    return {
      pressed: document.querySelector('[data-control="3d"]')?.getAttribute("aria-pressed") ?? null,
      wrapped: document.body.hasAttribute("data-device3d"),
      transform: orbit?.style.transform ?? "",
    };
  });
}

function shownViewHtml(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>("[data-view]:not([hidden])")?.outerHTML ?? "",
  );
}

/**
 * 2D → 3D → 2D (#16458): the toggle transitions into the three-quarter pose, arrow keys orbit the
 * focused viewport, a rotate keeps the orbit, and leaving 3D restores the shown view's DOM byte
 * for byte.
 */
async function checkDevice3d(page: Page): Promise<void> {
  const before = await shownViewHtml(page);
  await page.click('[data-control="3d"]');
  await page.waitForFunction(() =>
    document.querySelector<HTMLElement>("[data-orbit]")?.style.transform.includes("rotateY(30deg)"),
  );
  expect(await device3dState(page)).toMatchObject({ pressed: "true", wrapped: true });
  await page.focus("[data-viewport]");
  await page.keyboard.press("ArrowRight");
  expect((await device3dState(page)).transform).toContain("rotateY(35deg)");
  // Rotating in 3D turns the views inside the orbiting box, so the orbit holds through the turn.
  if (await page.$('[data-control="rotate"]')) {
    await page.click('[data-control="rotate"]');
    const orbiting = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-view]:not([hidden])")).every(
        (view) => view.closest("[data-orbit]") !== null,
      ),
    );
    expect(orbiting).toBe(true);
    expect((await device3dState(page)).transform).toContain("rotateY(35deg)");
    await finishAnimations(page);
    await page.click('[data-control="rotate"]');
    await finishAnimations(page);
  }
  // A plain drag still pans in screen space with the device turned around (185° yaw).
  await page.focus("[data-viewport]");
  for (let step = 0; step < 10; step++) {
    await page.keyboard.press("Shift+ArrowRight");
  }
  expect((await device3dState(page)).transform).toContain("rotateY(185deg)");
  // Each press restarts the orbit's transform transition; measure the settled pose, not a
  // mid-turn one (#17260).
  await finishAnimations(page);
  const centreX = () =>
    page.evaluate(() => {
      const box = document.querySelector("[data-view]:not([hidden]) > *")?.getBoundingClientRect();
      return box ? box.left + box.width / 2 : 0;
    });
  const before3dPan = await centreX();
  await page.mouse.move(400, 500);
  await page.mouse.down();
  await page.mouse.move(460, 500, { steps: 4 });
  await page.mouse.up();
  expect((await centreX()) - before3dPan).toBeGreaterThan(30);
  await page.click('[data-control="3d"]');
  await page.waitForFunction(() => !document.querySelector("[data-orbit]"));
  expect(await device3dState(page)).toEqual({ pressed: "false", wrapped: false, transform: "" });
  expect(await shownViewHtml(page)).toBe(before);
}

function writeOutput(engine: WebScreenshotEngine, name: string, png: Buffer): void {
  const path = join(OUT_DIR, webScreenshotOutputPath(engine, name));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
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
      writeOutput(WEB_SCREENSHOT_GOLDEN_ENGINE, `${name}.diff.png`, result.diffPng);
    }
    return `${(result.diffRatio * 100).toFixed(3)}% of pixels differ (limit ${PIXEL_RATIO * 100}%)`;
  }
  return undefined;
}

/**
 * Mid-rotation (#16545): both views are shown and turned; then the turn ends upright. Returns the
 * landscape screenshot, then checks that reduced motion turns back without animating.
 */
async function checkRotation(
  page: Page,
  engine: WebScreenshotEngine,
  name: string,
): Promise<Buffer> {
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
  writeOutput(engine, `${name}--landscape.png`, landscape);

  // Reduced motion skips the turn.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.click('[data-control="rotate"]');
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect((await shownView(page)).orientation).toBe("portrait");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  return landscape;
}

for (const engine of ENGINES) {
  describeBrowser(`prototype web page in headless ${engine} (#16346, #16459)`, () => {
    let browser: Browser;

    beforeAll(async () => {
      browser = await BROWSER_TYPES[engine].launch();
    }, LAUNCH_TIMEOUT_MS);

    afterAll(async () => {
      await browser?.close();
    });

    for (const entry of webScreenshotCases()) {
      test(
        entry.name,
        async () => {
          const { page, ...problems } = await openPage(browser, await webScreenshotPage(entry));
          try {
            const first = await shownView(page);
            expect(first.count).toBe(1);
            expect(first.orientation).toBe(entry.orientations[0]);
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
            writeOutput(engine, `${entry.name}.png`, screenshot);

            const landscape = entry.landscapeGolden
              ? await checkRotation(page, engine, entry.name)
              : undefined;
            if (!entry.landscapeGolden) {
              // A watch, TV or car never rotates (#16446): no control, and the one view stays shown.
              expect(await page.$('[data-control="rotate"]')).toBeNull();
              if (entry.orientations[0] === "landscape") {
                expect(first.width).toBeGreaterThan(first.height);
              }
            }

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

            await checkDevice3d(page);

            const violations = await page.evaluate((): string[] =>
              Reflect.get(globalThis, "__cspViolations"),
            );
            expect({
              consoleErrors: problems.consoleErrors,
              pageErrors: problems.pageErrors,
              requests: problems.requests,
              violations,
            }).toEqual({ consoleErrors: [], pageErrors: [], requests: [], violations: [] });

            // Goldens are trusted only from Chromium; the other engines run the behaviour above.
            if (engine !== WEB_SCREENSHOT_GOLDEN_ENGINE) {
              return;
            }
            expect(compareToGolden(entry.name, entry.golden, screenshot)).toBeUndefined();
            if (entry.landscapeGolden && landscape) {
              expect(
                compareToGolden(`${entry.name}--landscape`, entry.landscapeGolden, landscape),
              ).toBeUndefined();
            }
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
        const { page } = await openPage(browser, await webScreenshotPage(entry!), (opened) =>
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

    test("a fitted map stretched in a narrow column keeps both pins inside the box (#16679)", async () => {
      const markers = {
        path: "/ends",
        as: "end",
        lat: "{end.lat}",
        lng: "{end.lng}",
        title: "{end.name}",
      };
      const map = (fit: string, extra: Record<string, unknown>) => ({
        type: "map",
        fit,
        markers,
        polylines: [{ path: "/ends", width: 4 }],
        ...extra,
      });
      const reference = JSON.parse(
        readFileSync(
          join(import.meta.dir, "../../../fixtures/prototype-web/reference-checkout.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const { element } = renderPrototypeStill({
        ...reference,
        root: {
          type: "column",
          style: { width: { dp: 200 } },
          children: [
            map("markers", {}),
            map("route", { style: { height: { dp: 120 } } }),
            // Padding shrinks the content box the pins scale by; the route must scale with them.
            map("markers", { style: { padding: { start: 40, top: 10 } } }),
          ],
        },
        data: {
          ends: [
            { name: "West", lat: 0, lng: -1 },
            { name: "East", lat: 0.5, lng: 1 },
          ],
        },
      });
      const page = await browser.newPage({
        viewport: WEB_SCREENSHOT_VIEWPORT,
        deviceScaleFactor: 1,
      });
      try {
        await page.setContent(`<!doctype html><html><body>${toHtml(element)}</body></html>`);
        const boxes = await page.$$eval('[data-node="map"]', (maps) =>
          maps.map((map) => {
            const box = map.getBoundingClientRect();
            // A pin's point is where it is placed (`left`/`top`), before its transform moves the drawing.
            const tips = Array.from(map.querySelectorAll<HTMLElement>('[data-part="marker"]')).map(
              (pin) => ({
                x: box.left + map.clientLeft + pin.offsetLeft,
                y: box.top + map.clientTop + pin.offsetTop,
              }),
            );
            const polyline = map.querySelector("polyline");
            const line = polyline?.getBoundingClientRect();
            // The route's ends in page px, to meet the pin tips.
            const matrix = polyline?.getScreenCTM();
            const ends = Array.from(polyline?.points ?? [])
              .filter((_, index, all) => index === 0 || index === all.length - 1)
              .map((point) => point.matrixTransform(matrix ?? undefined))
              .map(({ x, y }) => ({ x, y }));
            return {
              box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
              tips,
              ends,
              line: line && {
                left: line.left,
                right: line.right,
                top: line.top,
                bottom: line.bottom,
              },
            };
          }),
        );
        expect(boxes).toHaveLength(3);
        for (const { box, tips, line, ends } of boxes) {
          expect(box.right - box.left).toBeCloseTo(200, 0);
          expect(tips).toHaveLength(2);
          for (const tip of tips) {
            expect(tip.x).toBeGreaterThan(box.left);
            expect(tip.x).toBeLessThan(box.right);
            expect(tip.y).toBeGreaterThan(box.top);
            expect(tip.y).toBeLessThan(box.bottom);
          }
          // The route runs between the pins, so it is inside the box too (its round caps aside).
          expect(line!.left).toBeGreaterThan(box.left);
          expect(line!.right).toBeLessThan(box.right);
          // Each pin's tip sits on its end of the route.
          for (const [index, end] of ends.entries()) {
            expect(Math.abs(end.x - tips[index]!.x)).toBeLessThan(1);
            expect(Math.abs(end.y - tips[index]!.y)).toBeLessThan(1);
          }
          expect(ends).toHaveLength(2);
        }
      } finally {
        await page.close();
      }
    });

    test("a repeat column's instances keep their aspect ratios inside their own share (#16694)", async () => {
      const reference = JSON.parse(
        readFileSync(
          join(import.meta.dir, "../../../fixtures/prototype-web/reference-checkout.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const ratioRow = {
        type: "row",
        testTag: "instance",
        style: { weight: 1 },
        children: [
          { type: "box", testTag: "ratio", style: { aspectRatio: 2, background: "#3366ff" } },
          { type: "text", text: "b" },
        ],
      };
      const { element } = renderPrototypeStill({
        ...reference,
        root: {
          type: "column",
          style: { width: { dp: 300 } },
          children: [
            {
              type: "column",
              style: { height: { dp: 40 } },
              repeat: { items: [{ id: 1 }, { id: 2 }] },
              children: [ratioRow],
            },
            {
              type: "row",
              testTag: "repeated",
              repeat: { items: [{ id: 1 }] },
              children: [{ type: "box", style: { aspectRatio: 2, maxWidth: 40 } }],
            },
          ],
        },
      });
      const page = await browser.newPage({
        viewport: WEB_SCREENSHOT_VIEWPORT,
        deviceScaleFactor: 1,
      });
      try {
        await page.setContent(`<!doctype html><html><body>${toHtml(element)}</body></html>`);
        const boxes = await page.evaluate(() => {
          const rects = (tag: string) =>
            Array.from(document.querySelectorAll(`[data-testid="${tag}"]`)).map((node) => {
              const box = node.getBoundingClientRect();
              return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
            });
          const repeated = document.querySelector('[data-testid="repeated"]');
          return {
            instances: rects("instance"),
            ratios: rects("ratio"),
            repeatedWidth: repeated?.getBoundingClientRect().width ?? 0,
            parentWidth: repeated?.parentElement?.getBoundingClientRect().width ?? 0,
          };
        });
        expect(boxes.instances).toHaveLength(2);
        expect(boxes.ratios).toHaveLength(2);
        const [first, second] = boxes.instances;
        // The two weighted instances split the column, and neither ratio spills into the next.
        expect(Math.abs(first!.height - second!.height)).toBeLessThan(0.5);
        boxes.ratios.forEach((ratio, index) => {
          const instance = boxes.instances[index]!;
          expect(ratio.height).toBeGreaterThan(0);
          expect(ratio.top).toBeGreaterThanOrEqual(instance.top - 0.5);
          expect(ratio.bottom).toBeLessThanOrEqual(instance.bottom + 0.5);
          expect(ratio.width / ratio.height).toBeCloseTo(2, 1);
        });
        // A repeated row is not stretched to its parent's width.
        expect(boxes.repeatedWidth).toBeLessThan(boxes.parentWidth);
      } finally {
        await page.close();
      }
    });

    test("row aspect ratios lay out at the widths Android's sizeIn-then-aspectRatio gives (#16795)", async () => {
      const box = (testTag: string, style: Record<string, unknown>) => ({
        type: "box",
        testTag,
        style: { background: "primary", ...style },
      });
      const text = (testTag: string, value: string) => ({ type: "text", testTag, text: value });
      const row = (width: number, children: unknown[]) => ({
        type: "row",
        style: { width: { dp: width } },
        children,
      });
      const square = (prefix: string) => box(`${prefix}-square`, { aspectRatio: 1, maxWidth: 100 });
      const reference = JSON.parse(
        readFileSync(
          join(import.meta.dir, "../../../fixtures/prototype-web/reference-checkout.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      const { element } = renderPrototypeStill({
        ...reference,
        root: {
          type: "column",
          style: { width: "fill" },
          children: [
            // The capped square keeps its 100 and the later sibling gives up its minWidth (#16772).
            row(100, [
              square("narrow"),
              box("narrow-later", { width: { dp: 40 }, minWidth: 40, height: { dp: 10 } }),
            ]),
            // With width to spare the later sibling still renders at least its minWidth.
            row(200, [
              square("wide"),
              box("wide-later", { width: { dp: 20 }, minWidth: 40, height: { dp: 10 } }),
            ]),
            // A capped ratio between two texts grows to its cap (#16681).
            row(200, [
              text("between-start", "a"),
              box("between-capped", { aspectRatio: 2, maxWidth: 100 }),
              text("between-end", "b"),
            ]),
            // An unsized ratio after a capped one takes what the cap and the text leave (#16681).
            row(300, [
              box("after-capped", { aspectRatio: 2, maxWidth: 100 }),
              text("after-text", "a"),
              box("after-unsized", { aspectRatio: 1 }),
              text("after-end", "b"),
            ]),
          ],
        },
      });
      const page = await browser.newPage({
        viewport: WEB_SCREENSHOT_VIEWPORT,
        deviceScaleFactor: 1,
      });
      try {
        await page.setContent(`<!doctype html><html><body>${toHtml(element)}</body></html>`);
        const widths = await page.$$eval("[data-testid]", (nodes) =>
          Object.fromEntries(
            nodes.map((node) => [
              node.getAttribute("data-testid") ?? "",
              node.getBoundingClientRect().width,
            ]),
          ),
        );
        const width = (testTag: string) => {
          expect(widths).toHaveProperty(testTag);
          return widths[testTag]!;
        };
        expect(width("narrow-square")).toBeCloseTo(100, 0);
        expect(width("narrow-later")).toBeCloseTo(0, 0);
        expect(width("wide-square")).toBeCloseTo(100, 0);
        expect(width("wide-later")).toBeCloseTo(40, 0);

        expect(width("between-capped")).toBeCloseTo(100, 0);
        expect(width("between-start")).toBeGreaterThan(0);
        expect(width("between-end")).toBeGreaterThan(0);

        const afterText = width("after-text");
        expect(width("after-capped")).toBeCloseTo(100, 0);
        expect(afterText).toBeGreaterThan(0);
        expect(width("after-unsized")).toBeCloseTo(300 - 100 - afterText, 0);
        expect(width("after-end")).toBeCloseTo(0, 0);
      } finally {
        await page.close();
      }
    });

    test("a padded text after an unsized aspect ratio in a row takes no width (#16710)", async () => {
      const spec = {
        id: "ratio-padded",
        root: {
          type: "column",
          children: [
            {
              type: "row",
              children: [
                { type: "box", testTag: "ratio", style: { aspectRatio: 2 } },
                {
                  type: "text",
                  testTag: "padded",
                  text: "Hi",
                  style: { padding: { start: 20, end: 20 } },
                },
              ],
            },
          ],
        },
      };
      const { page } = await openPage(browser, webSpecPage(spec, "ratio-padded"));
      try {
        const sizes = await page.evaluate(() => {
          // Layout px: undo the stage's fit-to-viewport scale.
          const stage = document.querySelector<HTMLElement>("[data-stage]");
          const scale = Number(/scale\(([\d.]+)\)/.exec(stage?.style.transform ?? "")?.[1] ?? 1);
          const view = Array.from(document.querySelectorAll<HTMLElement>("[data-view]")).find(
            (shown) => !shown.hidden,
          );
          const size = (tag: string) => {
            const box = view?.querySelector(`[data-testid="${tag}"]`)?.getBoundingClientRect();
            return [(box?.width ?? -1) / scale, (box?.height ?? -1) / scale];
          };
          return { ratio: size("ratio"), padded: size("padded") };
        });
        // A Pixel 9 screen is 411 dp wide: the ratio takes all of it and the padded text none.
        expect(sizes.ratio[0]).toBeCloseTo(411, 1);
        expect(sizes.ratio[1]).toBeCloseTo(205.5, 1);
        expect(sizes.padded[0]).toBeCloseTo(0, 1);
      } finally {
        await page.close();
      }
    });
  });
}

const FADE_FIXTURE = join(
  import.meta.dir,
  "../../../fixtures/prototype-web/fade-edges-overflow.json",
);

for (const engine of ENGINES) {
  describeBrowser(
    `scroll fade edges follow overflow in headless ${engine} (#16606, #16459)`,
    () => {
      let browser: Browser;

      beforeAll(async () => {
        browser = await BROWSER_TYPES[engine].launch();
      }, LAUNCH_TIMEOUT_MS);

      afterAll(async () => {
        await browser?.close();
      });

      for (const direction of ["ltr", "rtl"] as const) {
        test(
          `only an overflowing scroll fades its trailing edge (${direction})`,
          async () => {
            const base = JSON.parse(readFileSync(FADE_FIXTURE, "utf8")) as Record<string, unknown>;
            const window = {
              ...(base.window as Record<string, unknown>),
              layoutDirection: direction,
            };
            const { page } = await openPage(
              browser,
              webSpecPage({ ...base, window }, "fade-edges"),
            );
            try {
              // Without scroll-driven animations (Firefox today) the page keeps the fade always on.
              const followsOverflow = await page.evaluate(() =>
                CSS.supports("animation-timeline", "scroll()"),
              );
              // The mask comes from a scroll-driven animation whose `scroll(self)` timeline resolves on
              // a frame after load (#17143), so wait until every overflowing scroll draws it.
              await page.waitForFunction(() => {
                const overflowing = Array.from(
                  document.querySelectorAll<HTMLElement>("[data-view]:not([hidden]) [data-fade]"),
                ).filter((scroll) =>
                  scroll.dataset.fade === "x"
                    ? scroll.scrollWidth > scroll.clientWidth
                    : scroll.scrollHeight > scroll.clientHeight,
                );
                return (
                  overflowing.length > 0 &&
                  overflowing.every((scroll) => getComputedStyle(scroll).maskImage !== "none")
                );
              });
              const masks = await page.evaluate(() =>
                Object.fromEntries(
                  Array.from(
                    document.querySelectorAll<HTMLElement>("[data-view]:not([hidden]) [data-fade]"),
                  ).map((scroll) => [scroll.dataset.testid, getComputedStyle(scroll).maskImage]),
                ),
              );
              const trailing = direction === "rtl" ? "to right" : "to left";
              if (followsOverflow) {
                expect(masks["vertical-fits"]).toBe("none");
                expect(masks["horizontal-fits"]).toBe("none");
              } else {
                expect(masks["vertical-fits"]).toStartWith("linear-gradient(to top,");
                expect(masks["horizontal-fits"]).toStartWith(`linear-gradient(${trailing},`);
              }
              expect(masks["vertical-overflows"]).toStartWith("linear-gradient(to top,");
              expect(masks["horizontal-overflows"]).toStartWith(`linear-gradient(${trailing},`);
            } finally {
              await page.close();
            }
          },
          CASE_TIMEOUT_MS,
        );
      }
    },
  );
}
