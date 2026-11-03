import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPrototypeWebPage } from "../../../../src/features/prototype/web/webPage";

/**
 * The reference specs and frames the headless screenshot check renders (#16346), shared by the
 * browser check and the unit test that keeps the committed goldens in step with this list.
 */

const FIXTURES = join(import.meta.dir, "../../../fixtures");

/**
 * Committed goldens: two PNGs per case, `<spec>--<frame>.png` in portrait and
 * `<spec>--<frame>--landscape.png` at the end of the animated rotation (#16545).
 */
export const WEB_SCREENSHOT_GOLDEN_DIR = join(FIXTURES, "prototype-web/screenshots");

export const WEB_SCREENSHOT_FRAMES = ["pixel-9", "iphone-16"] as const;

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
  readonly frame: (typeof WEB_SCREENSHOT_FRAMES)[number];
  readonly fixture: string;
  readonly golden: string;
  readonly landscapeGolden: string;
}

export function webScreenshotCases(): WebScreenshotCase[] {
  return Object.entries(WEB_SCREENSHOT_SPECS).flatMap(([spec, fixture]) =>
    WEB_SCREENSHOT_FRAMES.map((frame) => ({
      name: `${spec}--${frame}`,
      spec,
      frame,
      fixture: join(FIXTURES, fixture),
      golden: join(WEB_SCREENSHOT_GOLDEN_DIR, `${spec}--${frame}.png`),
      landscapeGolden: join(WEB_SCREENSHOT_GOLDEN_DIR, `${spec}--${frame}--landscape.png`),
    })),
  );
}

/** The page under test: the case's spec as the only revision of the only variant. */
export function webScreenshotPage(entry: WebScreenshotCase): string {
  const spec: unknown = JSON.parse(readFileSync(entry.fixture, "utf8"));
  return buildPrototypeWebPage({
    title: entry.spec,
    frame: entry.frame,
    variants: [
      {
        id: entry.spec,
        label: entry.spec,
        revisions: [{ revision: 1, operation: "show", spec }],
      },
    ],
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

/**
 * Browser engines the check runs in (#16459). Every engine runs the behavioural assertions; only
 * `WEB_SCREENSHOT_GOLDEN_ENGINE` is compared with (or rewrites) the goldens, which are trusted
 * only from the CI Linux Chromium build.
 */
export const WEB_SCREENSHOT_ENGINES = ["chromium", "firefox", "webkit"] as const;
export type WebScreenshotEngine = (typeof WEB_SCREENSHOT_ENGINES)[number];
export const WEB_SCREENSHOT_GOLDEN_ENGINE: WebScreenshotEngine = "chromium";

function isWebScreenshotEngine(name: string): name is WebScreenshotEngine {
  return (WEB_SCREENSHOT_ENGINES as readonly string[]).includes(name);
}

/**
 * The engines named by a comma-separated list (`AUTOMOBILE_PROTOTYPE_WEB_ENGINES`), in canonical
 * order without duplicates. Unset or blank means every engine; an unknown name throws.
 */
export function webScreenshotEngines(value: string | undefined): WebScreenshotEngine[] {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    return [...WEB_SCREENSHOT_ENGINES];
  }
  const unknown = names.filter((name) => !isWebScreenshotEngine(name));
  if (unknown.length > 0) {
    throw new Error(
      `unknown browser engine(s): ${unknown.join(", ")} (expected ${WEB_SCREENSHOT_ENGINES.join(", ")})`,
    );
  }
  return WEB_SCREENSHOT_ENGINES.filter((engine) => names.includes(engine));
}

/**
 * Where a captured screenshot is written under the output directory: the golden engine's at the
 * top level, so adopting goldens stays a flat copy, and every other engine's under its own name.
 */
export function webScreenshotOutputPath(engine: WebScreenshotEngine, file: string): string {
  return engine === WEB_SCREENSHOT_GOLDEN_ENGINE ? file : join(engine, file);
}
