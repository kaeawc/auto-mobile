import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deviceFrameOrThrow } from "../../../../src/features/prototype/web/deviceFrames";
import {
  frameOrientations,
  type WebOrientation,
} from "../../../../src/features/prototype/web/webFrame";
import {
  buildPrototypeWebPage,
  type PrototypeWebPageInput,
} from "../../../../src/features/prototype/web/webPage";
import {
  buildPrototypeWebPageWithImages,
  SharpPrototypeWebImageEncoder,
  type PrototypeWebAssetSource,
} from "../../../../src/features/prototype/web/webImageEncoding";

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
  "image-gallery": "prototype-web/image-gallery.json",
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

/** Image assets the cases draw: `<asset id>.png`; an id without a file stays a placeholder. */
export const WEB_SCREENSHOT_ASSET_DIR = join(FIXTURES, "prototype-web/assets");

export const webScreenshotAssets: PrototypeWebAssetSource = {
  get: async (id) => {
    const file = join(WEB_SCREENSHOT_ASSET_DIR, `${id}.png`);
    return /^[a-z-]+$/.test(id) && existsSync(file)
      ? { mimeType: "image/png", bytes: new Uint8Array(readFileSync(file)) }
      : undefined;
  },
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
  readonly frame: string;
  readonly fixture: string;
  /** The frame's orientations, the one the page opens in first. */
  readonly orientations: readonly WebOrientation[];
  /** The page as it opens, in `orientations[0]`. */
  readonly golden: string;
  /** After rotating, for a frame with both orientations. */
  readonly landscapeGolden?: string;
  /** The system settings the page renders with; absent for the default ones. */
  readonly settings?: Pick<PrototypeWebPageInput, "locale" | "textSize">;
}

function screenshotCase(
  spec: string,
  frame: string,
  settings?: { name: string; input: Pick<PrototypeWebPageInput, "locale" | "textSize"> },
): WebScreenshotCase {
  const name = settings === undefined ? `${spec}--${frame}` : `${spec}--${frame}--${settings.name}`;
  const orientations = frameOrientations(deviceFrameOrThrow(frame));
  const golden = (suffix: string) => join(WEB_SCREENSHOT_GOLDEN_DIR, `${name}${suffix}.png`);
  return {
    name,
    spec,
    frame,
    fixture: join(FIXTURES, WEB_SCREENSHOT_SPECS[spec]!),
    orientations,
    golden: golden(""),
    ...(orientations.length > 1 ? { landscapeGolden: golden("--landscape") } : {}),
    ...(settings ? { settings: settings.input } : {}),
  };
}

export function webScreenshotCases(): WebScreenshotCase[] {
  return [
    ...Object.keys(WEB_SCREENSHOT_SPECS).flatMap((spec) =>
      WEB_SCREENSHOT_FRAMES.map((frame) => screenshotCase(spec, frame)),
    ),
    ...Object.entries(WEB_SCREENSHOT_SETTINGS).flatMap(([setting, input]) =>
      WEB_SCREENSHOT_FRAMES.map((frame) =>
        screenshotCase(WEB_SCREENSHOT_SETTINGS_SPEC, frame, { name: setting, input: input(frame) }),
      ),
    ),
    ...WEB_SCREENSHOT_FORM_FACTOR_FRAMES.map((frame) => screenshotCase(FORM_FACTOR_SPEC, frame)),
  ];
}

/** Every golden a case owns. */
export function webScreenshotGoldens(entry: WebScreenshotCase): string[] {
  return [entry.golden, ...(entry.landscapeGolden ? [entry.landscapeGolden] : [])];
}

/**
 * The page under test: the case's spec as the only revision of the only variant, its image assets
 * inlined from the fixture asset directory.
 */
export async function webScreenshotPage(entry: WebScreenshotCase): Promise<string> {
  const spec: unknown = JSON.parse(readFileSync(entry.fixture, "utf8"));
  const page = await buildPrototypeWebPageWithImages(
    {
      title: entry.spec,
      frame: entry.frame,
      ...entry.settings,
      variants: [
        {
          id: entry.spec,
          label: entry.spec,
          revisions: [{ revision: 1, operation: "show", spec }],
        },
      ],
    },
    webScreenshotAssets,
    new SharpPrototypeWebImageEncoder(),
  );
  return page.html;
}

/** A page showing one spec as the only revision of the only variant. */
export function webSpecPage(
  spec: unknown,
  name: string,
  frame: string = "pixel-9",
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
