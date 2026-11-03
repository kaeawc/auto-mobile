import { ActionableError } from "../../../models/ActionableError";

/**
 * System text size for a still: Android's font scale and iOS's Dynamic Type content size, applied
 * the way each native renderer scales text (#16552).
 */

/** iOS content size categories, named as `simctl ui content_size` and `displayConfig` name them. */
export const PROTOTYPE_CONTENT_SIZES = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const;

export type PrototypeContentSize = (typeof PROTOTYPE_CONTENT_SIZES)[number];

/** Android's font scale range in Settings (smallest to largest). */
export const ANDROID_FONT_SCALE_MIN = 0.85;
export const ANDROID_FONT_SCALE_MAX = 2;

export interface StillTextSize {
  /** Android only: the system font scale, 0.85 to 2 (default 1). */
  readonly fontScale?: number;
  /** iOS only: the Dynamic Type content size (default `large`). */
  readonly contentSize?: PrototypeContentSize;
}

/** How a still turns authored sp/pt values into CSS px. */
export interface TextScale {
  /** Font size and line height. */
  readonly font: (sp: number) => number;
  /** Letter spacing. */
  readonly tracking: (sp: number) => number;
}

/**
 * `UIFontMetrics.default` (the body style) point size per category; the renderer scales every
 * text size by `body / 17`, line height with it, and leaves tracking unscaled.
 */
const IOS_BODY_POINTS: Readonly<Record<PrototypeContentSize, number>> = {
  "extra-small": 14,
  small: 15,
  medium: 16,
  large: 17,
  "extra-large": 19,
  "extra-extra-large": 21,
  "extra-extra-extra-large": 23,
  "accessibility-medium": 28,
  "accessibility-large": 33,
  "accessibility-extra-large": 40,
  "accessibility-extra-extra-large": 47,
  "accessibility-extra-extra-extra-large": 53,
};

/** Android 14's `FontScaleConverterFactory` tables: sp keys and the dp each scale maps them to. */
const ANDROID_FROM_SP = [8, 10, 12, 14, 18, 20, 24, 30, 100] as const;
const ANDROID_TABLES: readonly (readonly [number, readonly number[]])[] = [
  [1, ANDROID_FROM_SP],
  [1.15, [9.2, 11.5, 13.8, 16.4, 19.8, 21.8, 25.2, 30, 100]],
  [1.3, [10.4, 13, 15.6, 18.8, 21.6, 23.6, 26.4, 30, 100]],
  [1.5, [12, 15, 18, 22, 24, 26, 28, 30, 100]],
  [1.8, [14.4, 18, 21.6, 24.4, 27.6, 30.8, 32.8, 34.8, 100]],
  [2, [16, 20, 24, 26, 30, 34, 36, 38, 100]],
];

/** Below this scale Android scales linearly. */
const ANDROID_NON_LINEAR_MIN = 1.03;

const lerp = (from: number, to: number, fraction: number): number => from + (to - from) * fraction;

/** The dp column for a scale, interpolating between its neighbouring tables as Android does. */
function androidTable(fontScale: number): readonly number[] {
  const exact = ANDROID_TABLES.find(([scale]) => scale === fontScale);
  if (exact) {
    return exact[1];
  }
  const higher = ANDROID_TABLES.findIndex(([scale]) => scale > fontScale);
  const [lowScale, low] = ANDROID_TABLES[higher - 1]!;
  const [highScale, high] = ANDROID_TABLES[higher]!;
  const fraction = (fontScale - lowScale) / (highScale - lowScale);
  return low.map((dp, index) => lerp(dp, high[index]!, fraction));
}

/** `FontScaleConverterTable.convertSpToDp`: piecewise linear, from 0 below the first key. */
function convertSpToDp(sp: number, toDp: readonly number[]): number {
  const magnitude = Math.abs(sp);
  const sign = Math.sign(sp);
  const last = ANDROID_FROM_SP.length - 1;
  if (magnitude >= ANDROID_FROM_SP[last]!) {
    return sp * (toDp[last]! / ANDROID_FROM_SP[last]!);
  }
  const upper = ANDROID_FROM_SP.findIndex((key) => key >= magnitude);
  const startSp = upper === 0 ? 0 : ANDROID_FROM_SP[upper - 1]!;
  const startDp = upper === 0 ? 0 : toDp[upper - 1]!;
  const fraction = (magnitude - startSp) / (ANDROID_FROM_SP[upper]! - startSp);
  return sign * lerp(startDp, toDp[upper]!, fraction);
}

/** Compose converts every sp value (size, line height, letter spacing) through the same curve. */
export function androidTextScale(fontScale: number): TextScale {
  if (fontScale < ANDROID_NON_LINEAR_MIN) {
    const linear = (sp: number): number => sp * fontScale;
    return { font: linear, tracking: linear };
  }
  const table = androidTable(fontScale);
  const convert = (sp: number): number => convertSpToDp(sp, table);
  return { font: convert, tracking: convert };
}

export function iosTextScale(contentSize: PrototypeContentSize): TextScale {
  const ratio = IOS_BODY_POINTS[contentSize] / IOS_BODY_POINTS.large;
  return { font: (pt) => pt * ratio, tracking: (pt) => pt };
}

function checkedFontScale(fontScale: number): number {
  if (
    !Number.isFinite(fontScale) ||
    fontScale < ANDROID_FONT_SCALE_MIN ||
    fontScale > ANDROID_FONT_SCALE_MAX
  ) {
    throw new ActionableError(
      `fontScale ${fontScale} is outside Android's range ${ANDROID_FONT_SCALE_MIN} to ${ANDROID_FONT_SCALE_MAX}.`,
    );
  }
  return fontScale;
}

function checkedContentSize(contentSize: string): PrototypeContentSize {
  const known = PROTOTYPE_CONTENT_SIZES.find((size) => size === contentSize);
  if (!known) {
    throw new ActionableError(
      `Unknown contentSize "${contentSize}". Valid sizes: ${PROTOTYPE_CONTENT_SIZES.join(", ")}.`,
    );
  }
  return known;
}

/** Each option belongs to one platform, so naming the other platform's option is refused. */
function checkPlatform(platform: "android" | "ios", size: StillTextSize): void {
  if (platform === "android" && size.contentSize !== undefined) {
    throw new ActionableError(
      "contentSize is iOS Dynamic Type; use fontScale for an Android frame.",
    );
  }
  if (platform === "ios" && size.fontScale !== undefined) {
    throw new ActionableError("fontScale is Android's; use contentSize for an iOS frame.");
  }
}

/** The text scale a frame's platform applies, or undefined at the default size. */
export function stillTextScale(
  platform: "android" | "ios",
  size: StillTextSize | undefined,
): TextScale | undefined {
  if (!size) {
    return undefined;
  }
  checkPlatform(platform, size);
  if (size.fontScale !== undefined && checkedFontScale(size.fontScale) !== 1) {
    return androidTextScale(size.fontScale);
  }
  if (size.contentSize !== undefined && checkedContentSize(size.contentSize) !== "large") {
    return iosTextScale(size.contentSize);
  }
  return undefined;
}
