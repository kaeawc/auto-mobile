import {
  ALIGN_ITEMS,
  ARIA_HIDDEN,
  BORDER_RADIUS,
  CENTER,
  FLEX_SHRINK,
  FONT_SIZE,
  FONT_WEIGHT,
  INLINE_FLEX,
  JUSTIFY_CONTENT,
  LINE_HEIGHT,
} from "./webCss";
import { el, type WebElement } from "./webNodes";

// Browser-safe: the still renderer bundles for the browser (#16451), so the Node-only Material
// Icons reader lives in materialIconGlyphs.ts and is injected by the server.

/** The contract's `iconVariant` values; anything else draws `filled`, as on Android. */
export type PrototypeIconVariant = "filled" | "outlined" | "rounded" | "sharp" | "twoTone";

/**
 * Where the web renderer finds an icon's glyph: the SVG shapes of a 24 x 24 viewBox, or
 * undefined when the name has no glyph in that variant or in `filled`.
 */
export interface PrototypeIconGlyphSource {
  glyph(name: string, variant: PrototypeIconVariant): readonly WebElement[] | undefined;
}

const VARIANTS: ReadonlySet<string> = new Set([
  "filled",
  "outlined",
  "rounded",
  "sharp",
  "twoTone",
]);

export function prototypeIconVariant(value: unknown): PrototypeIconVariant {
  return typeof value === "string" && VARIANTS.has(value)
    ? (value as PrototypeIconVariant)
    : "filled";
}

/** An icon's 24 px box; the spec's own style still wins. */
export const ICON_BOX: Readonly<Record<string, string>> = {
  display: INLINE_FLEX,
  width: "24px",
  height: "24px",
  [FLEX_SHRINK]: "0",
};

/** No glyph: a tinted ring around the name's initial, titled with the full name. */
export const ICON_PLACEHOLDER: Readonly<Record<string, string>> = {
  ...ICON_BOX,
  [ALIGN_ITEMS]: CENTER,
  [JUSTIFY_CONTENT]: CENTER,
  border: "2px solid currentColor",
  [BORDER_RADIUS]: "6px",
  [FONT_SIZE]: "11px",
  [FONT_WEIGHT]: "700",
  [LINE_HEIGHT]: "1",
};

/** The first letter of an icon's name, so a placeholder reads as that icon; none without a name. */
export function iconInitial(name: unknown): string {
  const letter = typeof name === "string" ? /[a-z0-9]/i.exec(name)?.[0] : undefined;
  return letter ? letter.toUpperCase() : "";
}

/**
 * A glyph filling its icon box, tinted by `currentColor` as Compose tints by LocalContentColor
 * unless the style sets one. The HTML parser restores `viewBox`'s case on an inline SVG.
 */
export function glyphSvg(shapes: readonly WebElement[]): WebElement {
  const attrs = { viewbox: "0 0 24 24", width: "100%", height: "100%", fill: "currentColor" };
  return el("svg", { attrs: { ...attrs, [ARIA_HIDDEN]: "true" } }, shapes);
}
