import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../../../../src/utils/logger";
import { materialIconGlyphs } from "../../../../src/features/prototype/web/materialIconGlyphs";
import { buildPrototypeWebPage } from "../../../../src/features/prototype/web/webPage";
import type { WebOrientation } from "../../../../src/features/prototype/web/webFrame";
import { toHtml } from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeWebPointViews } from "../../../../src/features/prototype/web/webPageViews";
import { prototypeWebPageViewDrawer } from "../../../../src/features/prototype/web/webPageData";
import { WEB_SCREENSHOT_SPECS } from "./webScreenshotCases";
import { webPageData } from "./webPageDrawn";

// Every screenshot spec on four frames draws its views through both paths: about a second.
const FIXTURES = join(import.meta.dir, "../../../fixtures");
const BOTH: readonly WebOrientation[] = ["portrait", "landscape"];
const at = (postures: readonly string[], orientations = BOTH) =>
  postures.flatMap((posture) => orientations.map((orientation) => ({ orientation, posture })));
const FRAMES = [
  { id: "pixel-9", points: at([""]) },
  { id: "iphone-16", points: at([""]) },
  { id: "pixel-fold", points: at(["opened", "closed", "half_opened"]) },
  { id: "apple-watch", points: at([""], ["portrait"]) },
];

describe("the page bundle draws the views the host would (#16528)", () => {
  for (const [name, path] of Object.entries(WEB_SCREENSHOT_SPECS)) {
    const spec = JSON.parse(readFileSync(join(FIXTURES, path), "utf8")) as unknown;
    for (const frame of FRAMES) {
      test(`${name} on ${frame.id}`, () => {
        const page = buildPrototypeWebPage({
          title: name,
          frame: frame.id,
          nowMs: 0,
          variants: [
            { id: "a", label: "A", revisions: [{ revision: 1, operation: "show", spec }] },
          ],
        });
        const data = webPageData(page.html);
        const drawn: string[] = [];
        const draw = prototypeWebPageViewDrawer(data, {
          views: () => [],
          insert: (html) => drawn.push(html),
        });
        // The host's own path: its Material Icons and logger, not the page's glyph table.
        const host = {
          frame: frame.id,
          nowMs: 0,
          imageSlots: new Map<string, number>(),
          glyphs: materialIconGlyphs(),
          logger,
        };
        for (const point of frame.points) {
          drawn.length = 0;
          draw({ variant: "a", revision: "1", ...point });
          const posture = point.posture === "" ? undefined : point.posture;
          const expected = renderPrototypeWebPointViews(
            host,
            { variant: "a", revision: 1, spec },
            { orientation: point.orientation, posture },
          ).map((view) => toHtml(view.element));
          expect(drawn).toEqual(expected);
        }
      });
    }
  }
});
