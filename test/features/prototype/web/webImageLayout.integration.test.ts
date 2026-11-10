import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { buildPrototypeWebPage } from "../../../../src/features/prototype/web/webPage";
import {
  measureWebImageLayout,
  WEB_IMAGE_LAYOUT_ASSETS,
  WEB_IMAGE_LAYOUT_SPEC,
  WEB_IMAGE_LAYOUT_VIEWPORT,
  webImageLayoutDifferences,
  webImageLayoutTags,
  type WebImageLayoutBoxes,
} from "./webImageLayoutCases";

/**
 * Headless Chromium check that un-padded inlined images lay out as they did before #17679 wrapped
 * their layers in a content box (#17716): each fixture's image, parent and drawn layer box must
 * match the golden, which was measured from the renderer at #17679's first parent. Opt-in, as it
 * launches a browser: it runs through `bash scripts/prototype/web-screenshots.sh` (Chromium), whose
 * `--update` rewrites the golden from the current renderer — only for a deliberate layout change.
 */
const RUN = process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS === "1";
const UPDATE = process.env.AUTOMOBILE_PROTOTYPE_WEB_SCREENSHOTS_UPDATE === "1";
const GOLDEN = join(import.meta.dir, "../../../fixtures/prototype-web/image-layout-golden.json");
const ASSET = join(import.meta.dir, "../../../fixtures/prototype-web/assets/sunset.png");
/** A cold browser start can exceed bun's 5 s default hook timeout. */
const LAUNCH_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 30_000;
const describeBrowser = RUN ? describe : describe.skip;

function fixturePage(): string {
  // The layout reads only each encode's reported size (the image's ratio), not its pixels.
  const bytes = new Uint8Array(readFileSync(ASSET));
  return buildPrototypeWebPage({
    title: "Image layout",
    frame: "pixel-9",
    variants: [
      {
        id: "image-layout",
        label: "Image layout",
        revisions: [{ revision: 1, operation: "show", spec: WEB_IMAGE_LAYOUT_SPEC }],
      },
    ],
    images: WEB_IMAGE_LAYOUT_ASSETS.map((asset) => ({ ...asset, bytes })),
  }).html;
}

describeBrowser("un-padded inlined image layout in Chromium (#17716)", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, LAUNCH_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  test(
    "every fixture's image, parent and layer box matches the pre-#17679 golden",
    async () => {
      const page = await browser.newPage({
        viewport: WEB_IMAGE_LAYOUT_VIEWPORT,
        deviceScaleFactor: 1,
      });
      await page.setContent(fixturePage(), { waitUntil: "load" });
      const tags = webImageLayoutTags();
      const actual = await page.evaluate(measureWebImageLayout, tags);
      await page.close();
      expect(Object.keys(actual).sort()).toEqual([...tags].sort());
      if (UPDATE) {
        writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
        return;
      }
      const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<
        string,
        WebImageLayoutBoxes
      >;
      expect(webImageLayoutDifferences(golden, actual)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});
