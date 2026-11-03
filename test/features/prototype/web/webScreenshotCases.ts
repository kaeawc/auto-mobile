import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deviceFrameOrThrow } from "../../../../src/features/prototype/web/deviceFrames";
import {
  frameOrientations,
  type WebOrientation,
} from "../../../../src/features/prototype/web/webFrame";
import { buildPrototypeWebPage } from "../../../../src/features/prototype/web/webPage";

/**
 * The reference specs and frames the headless screenshot check renders (#16346), shared by the
 * browser check and the unit test that keeps the committed goldens in step with this list.
 */

const FIXTURES = join(import.meta.dir, "../../../fixtures");

/**
 * Committed goldens: two PNGs per case of a frame that rotates, `<spec>--<frame>.png` in portrait
 * and `<spec>--<frame>--landscape.png` at the end of the animated rotation (#16545); one,
 * `<spec>--<frame>.png` in its only orientation, for a watch, TV or car frame.
 */
export const WEB_SCREENSHOT_GOLDEN_DIR = join(FIXTURES, "prototype-web/screenshots");

export const WEB_SCREENSHOT_FRAMES = ["pixel-9", "iphone-16"] as const;

/**
 * One reference spec per watch, TV and car frame (#16446), rather than every spec on every frame,
 * so the golden count grows by one per frame.
 */
export const WEB_SCREENSHOT_FORM_FACTOR_FRAMES = [
  "wearos-small-round",
  "apple-watch",
  "android-tv-1080p",
  "apple-tv",
  "car-1024p-landscape",
] as const;
const FORM_FACTOR_SPEC = "reference-checkout";

/** Spec name to fixture path under test/fixtures. */
export const WEB_SCREENSHOT_SPECS: Readonly<Record<string, string>> = {
  "reference-checkout": "prototype-web/reference-checkout.json",
  "template-feed-detail": "prototype-spec/valid/template-feed-detail.json",
  "pager-indicator-dots": "prototype-spec/valid/pager-indicator-dots.json",
  "grid-fixed-columns-span": "prototype-spec/valid/grid-fixed-columns-span.json",
  "material-controls": "prototype-spec/valid/material-controls.json",
  "component-gallery": "prototype-spec/valid/component-gallery.json",
  "doc-example-2": "prototype-spec/valid/doc-example-2.json",
  "status-bar-light-content": "prototype-web/status-bar-light-content.json",
  "status-bar-dark-content": "prototype-web/status-bar-dark-content.json",
};

/** The browser viewport, in CSS px at device scale factor 1, so a golden is exactly this size. */
export const WEB_SCREENSHOT_VIEWPORT = { width: 800, height: 800 } as const;

/**
 * Forces one generic font stack so a golden does not depend on which font `system-ui` resolves
 * to; DejaVu Sans ships with Playwright's Linux browser dependencies. No font is bundled.
 */
export const WEB_SCREENSHOT_FONT_CSS =
  '*{font-family:"DejaVu Sans",sans-serif!important;caret-color:transparent!important}';

export interface WebScreenshotCase {
  readonly name: string;
  readonly spec: string;
  readonly frame: string;
  readonly fixture: string;
  /** The frame's orientations, the one the page opens in first. */
  readonly orientations: readonly WebOrientation[];
  /** The page as it opens, in `orientations[0]`. */
  readonly golden: string;
  /** After rotating, for a frame with both orientations. */
  readonly landscapeGolden?: string;
}

function screenshotCase(spec: string, frame: string): WebScreenshotCase {
  const orientations = frameOrientations(deviceFrameOrThrow(frame));
  const golden = (suffix: string) =>
    join(WEB_SCREENSHOT_GOLDEN_DIR, `${spec}--${frame}${suffix}.png`);
  return {
    name: `${spec}--${frame}`,
    spec,
    frame,
    fixture: join(FIXTURES, WEB_SCREENSHOT_SPECS[spec]!),
    orientations,
    golden: golden(""),
    ...(orientations.length > 1 ? { landscapeGolden: golden("--landscape") } : {}),
  };
}

export function webScreenshotCases(): WebScreenshotCase[] {
  return [
    ...Object.keys(WEB_SCREENSHOT_SPECS).flatMap((spec) =>
      WEB_SCREENSHOT_FRAMES.map((frame) => screenshotCase(spec, frame)),
    ),
    ...WEB_SCREENSHOT_FORM_FACTOR_FRAMES.map((frame) => screenshotCase(FORM_FACTOR_SPEC, frame)),
  ];
}

/** Every golden a case owns. */
export function webScreenshotGoldens(entry: WebScreenshotCase): string[] {
  return [entry.golden, ...(entry.landscapeGolden ? [entry.landscapeGolden] : [])];
}

/** The page under test: the case's spec as the only revision of the only variant. */
export function webScreenshotPage(entry: WebScreenshotCase): string {
  const spec: unknown = JSON.parse(readFileSync(entry.fixture, "utf8"));
  return webSpecPage(spec, entry.spec, entry.frame);
}

/** A page showing one spec as the only revision of the only variant. */
export function webSpecPage(
  spec: unknown,
  name: string,
  frame: (typeof WEB_SCREENSHOT_FRAMES)[number] = "pixel-9",
): string {
  return buildPrototypeWebPage({
    title: name,
    frame,
    variants: [{ id: name, label: name, revisions: [{ revision: 1, operation: "show", spec }] }],
  }).html;
}

/** A PNG's width and height from its IHDR chunk, without decoding the pixels. */
export function pngSize(png: Buffer): { width: number; height: number } {
  const signature = "89504e470d0a1a0a";
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("not a PNG");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
