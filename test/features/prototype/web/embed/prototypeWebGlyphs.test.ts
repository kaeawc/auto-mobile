import { describe, expect, test } from "bun:test";
import {
  envelopeGlyphSource,
  markupGlyphParser,
  type PrototypeGlyphDocument,
  type PrototypeGlyphMarkupParser,
  type PrototypeGlyphNode,
} from "../../../../../src/features/prototype/web/embed/prototypeWebGlyphs";
import { el } from "../../../../../src/features/prototype/web/webNodes";

const node = (
  localName: string,
  attributes: Record<string, string> = {},
  children: PrototypeGlyphNode[] = [],
): PrototypeGlyphNode => ({
  localName,
  attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
  children,
});

/** Hands back a fixed tree, recording the markup it was asked to parse. */
function fakeParser(root: PrototypeGlyphNode, errors = 0) {
  const seen: string[] = [];
  const parser: PrototypeGlyphMarkupParser = {
    parseFromString(markup): PrototypeGlyphDocument {
      seen.push(markup);
      return { documentElement: root, getElementsByTagName: () => ({ length: errors }) };
    },
  };
  return { parser, seen };
}

describe("envelope glyphs (#16453)", () => {
  test("parse allow-listed shapes inside an svg wrapper", () => {
    const { parser, seen } = fakeParser(
      node("svg", {}, [node("g", {}, [node("path", { d: "M0 0" })])]),
    );
    expect(markupGlyphParser(parser)("<g><path d='M0 0'/></g>")).toEqual([
      el("g", { attrs: {} }, [el("path", { attrs: { d: "M0 0" } })]),
    ]);
    expect(seen).toEqual([`<svg xmlns="http://www.w3.org/2000/svg"><g><path d='M0 0'/></g></svg>`]);
  });

  test("drop a glyph holding any other element, or markup that does not parse", () => {
    const script = fakeParser(node("svg", {}, [node("path"), node("script")]));
    expect(markupGlyphParser(script.parser)("x")).toBeUndefined();
    const broken = fakeParser(node("svg", {}, [node("path")]), 1);
    expect(markupGlyphParser(broken.parser)("x")).toBeUndefined();
  });

  test("look up `<variant>/<name>` and parse each glyph once", () => {
    const parsed: string[] = [];
    const source = envelopeGlyphSource({ "outlined/home": "<path/>" }, (markup) => {
      parsed.push(markup);
      return [el("path")];
    });
    expect(source.glyph("home", "outlined")).toEqual([el("path")]);
    expect(source.glyph("home", "outlined")).toEqual([el("path")]);
    expect(source.glyph("home", "filled")).toBeUndefined();
    expect(source.glyph("toString", "filled")).toBeUndefined();
    expect(parsed).toEqual(["<path/>"]);
  });
});
