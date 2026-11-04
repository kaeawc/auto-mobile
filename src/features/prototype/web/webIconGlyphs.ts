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
  display: "inline-flex",
  width: "24px",
  height: "24px",
  "flex-shrink": "0",
};

/** No glyph: a tinted ring around the name's initial, titled with the full name. */
export const ICON_PLACEHOLDER: Readonly<Record<string, string>> = {
  ...ICON_BOX,
  "align-items": "center",
  "justify-content": "center",
  border: "2px solid currentColor",
  "border-radius": "6px",
  "font-size": "11px",
  "font-weight": "700",
  "line-height": "1",
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
  return el("svg", { attrs: { ...attrs, "aria-hidden": "true" } }, shapes);
}
