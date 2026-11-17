import type { PrototypeIconGlyphSource, PrototypeIconVariant } from "../webIconGlyphs";
import { el, type WebElement } from "../webNodes";

/** Turns one envelope glyph's SVG markup into shapes; undefined when it does not parse. */
export type PrototypeGlyphParser = (markup: string) => readonly WebElement[] | undefined;

/** The shapes an envelope glyph may hold; any other element drops the whole glyph. */
const GLYPH_TAGS: ReadonlySet<string> = new Set([
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polygon",
  "polyline",
  "g",
]);

/** The parsed node a glyph walk reads: what a DOM `Element` exposes. */
export interface PrototypeGlyphNode {
  readonly localName: string;
  readonly attributes: Iterable<{ readonly name: string; readonly value: string }>;
  readonly children: Iterable<PrototypeGlyphNode>;
}

/** What the parser hands back: a DOM `Document`, narrowed. */
export interface PrototypeGlyphDocument {
  readonly documentElement: PrototypeGlyphNode;
  getElementsByTagName(name: string): { readonly length: number };
}

export interface PrototypeGlyphMarkupParser {
  parseFromString(markup: string, type: "image/svg+xml"): PrototypeGlyphDocument;
}

function shape(node: PrototypeGlyphNode): WebElement | undefined {
  if (!GLYPH_TAGS.has(node.localName)) {
    return undefined;
  }
  const attrs = Object.fromEntries([...node.attributes].map((attr) => [attr.name, attr.value]));
  const children = [...node.children].map(shape);
  return children.every((child) => child !== undefined)
    ? el(node.localName, { attrs }, children)
    : undefined;
}

/** A glyph parser over the browser's `DOMParser`: allow-listed shapes only, nothing executes. */
export function markupGlyphParser(parser: PrototypeGlyphMarkupParser): PrototypeGlyphParser {
  return (markup) => {
    const document = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`,
      "image/svg+xml",
    );
    if (document.getElementsByTagName("parsererror").length > 0) {
      return undefined;
    }
    const shapes = [...document.documentElement.children].map(shape);
    return shapes.every((node) => node !== undefined) ? shapes : undefined;
  };
}

/** The envelope's glyphs, keyed `<variant>/<name>`, as the still renderer's glyph source. */
export function envelopeGlyphSource(
  glyphs: Readonly<Record<string, string>>,
  parse: PrototypeGlyphParser,
): PrototypeIconGlyphSource {
  const parsed = new Map<string, readonly WebElement[] | undefined>();
  return {
    glyph(name: string, variant: PrototypeIconVariant) {
      const key = `${variant}/${name}`;
      const markup = Object.hasOwn(glyphs, key) ? glyphs[key] : undefined;
      if (markup === undefined) {
        return undefined;
      }
      if (!parsed.has(key)) {
        parsed.set(key, parse(markup));
      }
      return parsed.get(key);
    },
  };
}
