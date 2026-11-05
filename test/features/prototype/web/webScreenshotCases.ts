import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPrototypeWebPage,
  type PrototypeWebPageInput,
} from "../../../../src/features/prototype/web/webPage";

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
  "flow-basic": "prototype-spec/valid/flow-basic.json",
  "flow-max-lines-repeat": "prototype-spec/valid/flow-max-lines-repeat.json",
  "chart-variants": "prototype-spec/valid/chart-variants.json",
  "status-bar-light-content": "prototype-web/status-bar-light-content.json",
  "status-bar-dark-content": "prototype-web/status-bar-dark-content.json",
  // Every button variant and two sliders: Material on pixel-9, the native iOS skin on iphone-16.
  "native-controls": "prototype-web/native-controls.json",
};

/**
 * System settings drawn beyond the default, on one reference spec in every frame (#16552): the
 * largest text size each platform offers, and an RTL locale. Golden `<spec>--<frame>--<setting>.png`.
 */
export const WEB_SCREENSHOT_SETTINGS_SPEC = "reference-checkout";

export const WEB_SCREENSHOT_SETTINGS: Readonly<
  Record<string, (frame: WebScreenshotFrame) => Pick<PrototypeWebPageInput, "locale" | "textSize">>
> = {
  "largest-text": (frame) => ({
    textSize:
      frame === "pixel-9"
        ? { fontScale: 2 }
        : { contentSize: "accessibility-extra-extra-extra-large" },
  }),
  rtl: () => ({ locale: "ar" }),
};

/** The browser viewport, in CSS px at device scale factor 1, so a golden is exactly this size. */
export const WEB_SCREENSHOT_VIEWPORT = { width: 800, height: 800 } as const;

/**
 * Forces one generic font stack so a golden does not depend on which font `system-ui` resolves
 * to; DejaVu Sans ships with Playwright's Linux browser dependencies. No font is bundled.
 */
export const WEB_SCREENSHOT_FONT_CSS =
  '*{font-family:"DejaVu Sans",sans-serif!important;caret-color:transparent!important}';

type WebScreenshotFrame = (typeof WEB_SCREENSHOT_FRAMES)[number];

export interface WebScreenshotCase {
  readonly name: string;
  readonly spec: string;
  readonly frame: WebScreenshotFrame;
  readonly fixture: string;
  readonly golden: string;
  /** The system settings the page renders with; absent for the default ones. */
  readonly landscapeGolden: string;
  /** The system settings the page renders with; absent for the default ones. */
  readonly settings?: Pick<PrototypeWebPageInput, "locale" | "textSize">;
}

function screenshotCase(
  spec: string,
  frame: WebScreenshotFrame,
  setting?: string,
): WebScreenshotCase {
  const name = setting === undefined ? `${spec}--${frame}` : `${spec}--${frame}--${setting}`;
  const settings = setting === undefined ? undefined : WEB_SCREENSHOT_SETTINGS[setting]?.(frame);
  return {
    name,
    spec,
    frame,
    fixture: join(FIXTURES, WEB_SCREENSHOT_SPECS[spec]!),
    golden: join(WEB_SCREENSHOT_GOLDEN_DIR, `${name}.png`),
    landscapeGolden: join(WEB_SCREENSHOT_GOLDEN_DIR, `${name}--landscape.png`),
    ...(settings ? { settings } : {}),
  };
}

export function webScreenshotCases(): WebScreenshotCase[] {
  return [
    ...Object.keys(WEB_SCREENSHOT_SPECS).flatMap((spec) =>
      WEB_SCREENSHOT_FRAMES.map((frame) => screenshotCase(spec, frame)),
    ),
    ...Object.keys(WEB_SCREENSHOT_SETTINGS).flatMap((setting) =>
      WEB_SCREENSHOT_FRAMES.map((frame) =>
        screenshotCase(WEB_SCREENSHOT_SETTINGS_SPEC, frame, setting),
      ),
    ),
  ];
}

/** The page under test: the case's spec as the only revision of the only variant. */
export function webScreenshotPage(entry: WebScreenshotCase): string {
  const spec: unknown = JSON.parse(readFileSync(entry.fixture, "utf8"));
  return webSpecPage(spec, entry.spec, entry.frame, entry.settings);
}

/** A page showing one spec as the only revision of the only variant. */
export function webSpecPage(
  spec: unknown,
  name: string,
  frame: (typeof WEB_SCREENSHOT_FRAMES)[number] = "pixel-9",
  settings: Pick<PrototypeWebPageInput, "locale" | "textSize"> = {},
): string {
  return buildPrototypeWebPage({
    title: name,
    frame,
    ...settings,
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
