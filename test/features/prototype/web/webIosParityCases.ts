import { readFileSync } from "node:fs";
import { join } from "node:path";
import { materialIconGlyphs } from "../../../../src/features/prototype/web/materialIconGlyphs";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";
import { toHtml } from "../../../../src/features/prototype/web/webNodes";
import {
  ANDROID_PARITY_CASES,
  ANDROID_PARITY_SKIPS,
  androidParitySpec,
  contentOnly,
  type AndroidParitySkip,
  type AndroidParityCase,
} from "./webAndroidParityCases";
export { parityAllowance } from "./webAndroidParityCases";

const REPO = join(import.meta.dir, "../../../..");
export const IOS_GOLDEN_DIR = join(REPO, "ios/prototype-agent/Goldens/iphone-16");
export const IOS_PARITY_BUDGETS = join(REPO, "test/fixtures/prototype-web/ios-parity-budgets.json");
export const IOS_PARITY_VIEWPORT = { width: 393, height: 852 } as const;
export const IOS_PARITY_SCALE = 3;
export const IOS_PARITY_TOP_PT = 0;
export const IOS_PARITY_BOTTOM_PT = 0;
export const IOS_PARITY_CLIP = {
  x: 0,
  y: IOS_PARITY_TOP_PT,
  width: IOS_PARITY_VIEWPORT.width,
  height: IOS_PARITY_VIEWPORT.height - IOS_PARITY_TOP_PT - IOS_PARITY_BOTTOM_PT,
} as const;
/**
 * The system status bar's glyphs (time, signal, battery) are drawn by the simulator over the
 * viewer's content, so both images ignore them. Pixel rects at 3x; the recorder pins the clock.
 */
export const IOS_PARITY_IGNORE = [
  { left: 120, top: 42, right: 330, bottom: 132 },
  { left: 810, top: 42, right: 1125, bottom: 132 },
] as const;
export const IOS_PARITY_WIDTH = IOS_PARITY_CLIP.width * IOS_PARITY_SCALE;
export const IOS_PARITY_HEIGHT = IOS_PARITY_CLIP.height * IOS_PARITY_SCALE;
export const IOS_PARITY_CROP_TOP_PX = IOS_PARITY_TOP_PT * IOS_PARITY_SCALE;

/** Add viewer limitations here with a reason; the emitter and browser share the filtered list. */
export const IOS_PARITY_SKIPS: readonly AndroidParitySkip[] = [...ANDROID_PARITY_SKIPS];
export const IOS_PARITY_CASES = ANDROID_PARITY_CASES.filter(
  (entry) => !IOS_PARITY_SKIPS.some((skip) => skip.golden === entry.golden),
);

/** Pin only the screen default; preserve authored font families. */
export const IOS_PARITY_FONT_CSS =
  '[data-chrome="screen"]{font-family:"DejaVu Sans",sans-serif!important}*{caret-color:transparent!important}';

/** Keep the iOS skin and safe-area environment while removing the decorative frame. */
export function iosParityHtml(entry: AndroidParityCase): string {
  const still = renderPrototypeStill(contentOnly(androidParitySpec(entry)), {
    frame: "iphone-16",
    mode: entry.mode ?? "light",
    glyphs: materialIconGlyphs(),
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0}[data-chrome="frame"]{padding:0!important;background:transparent!important;border-radius:0!important}[data-chrome="screen"]{border-radius:0!important}</style></head><body>${toHtml(still.element)}</body></html>\n`;
}

export function readIosParityBudgets(): Record<string, number> {
  return JSON.parse(readFileSync(IOS_PARITY_BUDGETS, "utf8"));
}
