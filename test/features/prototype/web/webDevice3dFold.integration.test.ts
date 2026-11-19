import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  PROTOTYPE_WEB_START_ORBIT,
  prototypeWebPose,
} from "../../../../src/features/prototype/web/webDevice3d";
import { webSpecPage } from "./webScreenshotCases";

/**
 * The opt-in 3D view folding a foldable frame in headless Chromium (#16458): the posture select
 * turns the moving leaf to each posture's hinge angle, the status line names the layout shown,
 * and leaving 3D restores the shown view's DOM byte for byte. Opt-in like the page check: run
 * through `bash scripts/prototype/web-screenshots.sh`; screenshots land in the output directory.
 */
const RUN = process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS === "1";
const describeBrowser = RUN ? describe : describe.skip;
const OUT_DIR = join(
  process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_OUT ??
    join(import.meta.dir, "../../../../scratch/prototype-web-screenshots"),
  "device-3d",
);
const PAGE_URL = "http://prototype-web.test/";
const VIEWPORT = { width: 1280, height: 1000 };
const CASE_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 30_000;
/** The stills' 9:41, as the page check pins it. */
const STILL_TIME = "2026-01-01T09:41:00Z";

const spec = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/prototype-web/reference-checkout.json"),
    "utf8",
  ),
) as Record<string, unknown>;

/** A book fold turns about a vertical hinge, a flip fold about a horizontal one. */
const FOLDS = [
  { frame: "pixel-fold", axis: "vertical" },
  { frame: "flip-foldable", axis: "horizontal" },
] as const;
const POSTURES = [
  { posture: "opened", hinge: 180 },
  { posture: "half_opened", hinge: 90 },
  { posture: "closed", hinge: 0 },
] as const;

async function open(browser: Browser, html: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    timezoneId: "UTC",
  });
  // The status bar clock is live; fixed, it cannot tick between the before and after DOM reads.
  await page.clock.setFixedTime(STILL_TIME);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.route("**/*", (route) =>
    route.request().url() === PAGE_URL
      ? route.fulfill({ contentType: "text/html; charset=utf-8", body: html })
      : route.abort("blockedbyclient"),
  );
  await page.goto(PAGE_URL, { waitUntil: "load" });
  return { page, errors };
}

function shownViewHtml(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>("[data-view]:not([hidden])")?.outerHTML ?? "",
  );
}

/** The posture of the view the page shows, once every transition has finished. */
async function shownPosture(page: Page): Promise<string> {
  await page.evaluate(() => {
    document.getAnimations().forEach((animation) => animation.finish());
  });
  return page.evaluate(
    () => document.querySelector<HTMLElement>("[data-view]:not([hidden])")?.dataset.posture ?? "",
  );
}

/** The fold as drawn once every transition has finished. */
async function settledFold(page: Page) {
  await page.evaluate(() => {
    document.getAnimations().forEach((animation) => animation.finish());
  });
  return page.evaluate(() => ({
    leaf: document.querySelector<HTMLElement>("[data-leaf]")?.style.transform ?? "",
    orbit: document.querySelector<HTMLElement>("[data-orbit]")?.style.transform ?? "",
    status: document.querySelector('[data-control="status3d"]')?.textContent ?? "",
    hinge: document.querySelector<HTMLInputElement>('[data-control="hinge"]')?.value ?? "",
  }));
}

describeBrowser("3D fold postures in headless Chromium (#16458)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, LAUNCH_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  for (const { frame, axis } of FOLDS) {
    test(
      `${frame} folds through opened, half_opened and closed, then returns to 2D unchanged`,
      async () => {
        const { page, errors } = await open(browser, webSpecPage(spec, `fold-${frame}`, frame));
        try {
          const before = await shownViewHtml(page);
          await page.click('[data-control="3d"]');
          await page.waitForFunction(() =>
            document
              .querySelector<HTMLElement>("[data-orbit]")
              ?.style.transform.includes("rotateY(30deg)"),
          );
          mkdirSync(OUT_DIR, { recursive: true });
          for (const { posture, hinge } of POSTURES) {
            await page.selectOption('[data-control="posture"]', posture);
            const fold = await settledFold(page);
            writeFileSync(
              join(OUT_DIR, `${frame}--${posture}.png`),
              await page.screenshot({ animations: "disabled", caret: "hide" }),
            );
            const pose = prototypeWebPose(PROTOTYPE_WEB_START_ORBIT, hinge, axis);
            expect({ posture, ...fold }).toEqual({
              posture,
              leaf: pose.leaf,
              orbit: pose.device,
              status: `Hinge ${hinge}°, ${posture} layout`,
              hinge: String(hinge),
            });
          }
          await page.click('[data-control="3d"]');
          await page.waitForFunction(() => !document.querySelector("[data-orbit]"));
          expect(await page.evaluate(() => document.body.hasAttribute("data-device3d"))).toBe(
            false,
          );
          expect(await shownViewHtml(page)).toBe(before);
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      },
      CASE_TIMEOUT_MS,
    );
  }

  for (const { frame } of FOLDS) {
    test(
      `${frame} reflows to each open posture's view as the hinge crosses it, never to closed`,
      async () => {
        const { page, errors } = await open(browser, webSpecPage(spec, `reflow-${frame}`, frame));
        try {
          const before = await shownViewHtml(page);
          expect(await shownPosture(page)).toBe("opened");
          await page.click('[data-control="3d"]');
          const shown: string[] = [];
          for (const posture of ["half_opened", "closed", "opened", "half_opened"]) {
            await page.selectOption('[data-control="posture"]', posture);
            shown.push(await shownPosture(page));
          }
          // Shutting keeps the last open layout: the closed view is the cover panel's.
          expect(shown).toEqual(["half_opened", "half_opened", "opened", "half_opened"]);
          // The reflowed view is wrapped for 3D like the one it replaced.
          expect(
            await page.evaluate(() =>
              document.querySelector("[data-view]:not([hidden])")?.hasAttribute("data-wrapped"),
            ),
          ).toBe(true);
          await page.click('[data-control="3d"]');
          await page.waitForFunction(() => !document.querySelector("[data-orbit]"));
          expect(await shownPosture(page)).toBe("opened");
          expect(await shownViewHtml(page)).toBe(before);
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      },
      CASE_TIMEOUT_MS,
    );
  }

  test(
    "a reflow keeps the user's zoom and pan, through 3D and back to 2D",
    async () => {
      const { page, errors } = await open(browser, webSpecPage(spec, "reflow-zoom", "pixel-fold"));
      const stageTransform = () =>
        page.evaluate(() => document.querySelector<HTMLElement>("[data-stage]")?.style.transform);
      try {
        await page.click('[data-control="zoom-in"]');
        const before = { html: await shownViewHtml(page), stage: await stageTransform() };
        await page.click('[data-control="3d"]');
        await page.selectOption('[data-control="posture"]', "half_opened");
        expect(await shownPosture(page)).toBe("half_opened");
        expect(await stageTransform()).toBe(before.stage);
        await page.click('[data-control="3d"]');
        await page.waitForFunction(() => !document.querySelector("[data-orbit]"));
        expect(await shownPosture(page)).toBe("opened");
        expect({ html: await shownViewHtml(page), stage: await stageTransform() }).toEqual(before);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    CASE_TIMEOUT_MS,
  );
});
