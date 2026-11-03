import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  glyphShapes,
  MaterialIconGlyphSource,
  materialIconGlyphs,
  type PrototypeIconGlyphSource,
  type PrototypeIconVariant,
} from "../../../../src/features/prototype/web/webIconGlyphs";
import {
  el,
  toHtml,
  type WebChild,
  type WebElement,
} from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";
import { WEB_SCREENSHOT_SPECS } from "./webScreenshotCases";

const FIXTURES = join(import.meta.dir, "../../../fixtures");

const svg = (body: string, viewBox = "0 0 24 24") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="${viewBox}">${body}</svg>`;

/** A glyph source holding one path per known name, recording every lookup. */
class FakeGlyphSource implements PrototypeIconGlyphSource {
  readonly asked: string[] = [];
  constructor(private readonly known: ReadonlySet<string>) {}
  glyph(name: string, variant: PrototypeIconVariant): readonly WebElement[] | undefined {
    this.asked.push(`${variant}/${name}`);
    return this.known.has(name) ? [el("path", { attrs: { d: `M0 0h${name.length}` } })] : undefined;
  }
}

function find(node: WebChild, predicate: (element: WebElement) => boolean): WebElement[] {
  if (typeof node === "string") {
    return [];
  }
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap((c) => find(c, predicate))];
}

const iconSpec = (children: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "icons",
  ...extra,
  root: { type: "column", children },
});

describe("icon glyph shapes (#16532)", () => {
  test("parses paths, circles, ellipses and groups with their drawing attributes", () => {
    const shapes = glyphShapes(
      svg(
        '<path d="M1 1z" opacity=".3"/><g><circle cx="12" cy="12" r="2"/></g><ellipse rx="1" ry="2"/>',
      ),
    );
    expect(shapes?.map((shape) => toHtml(shape)).join("")).toBe(
      '<path d="M1 1z" opacity=".3"></path><g><circle cx="12" cy="12" r="2"></circle></g><ellipse rx="1" ry="2"></ellipse>',
    );
  });

  test("refuses id references, other elements and other viewBoxes", () => {
    expect(
      glyphShapes(svg('<defs><path id="a" d="M0 0"/></defs><use href="#a"/>')),
    ).toBeUndefined();
    expect(glyphShapes(svg('<path d="M0 0" clip-path="url(#b)"/>'))).toBeUndefined();
    expect(glyphShapes(svg('<path d="M0 0"/>', "0 0 48 48"))).toBeUndefined();
    expect(glyphShapes(svg(""))).toBeUndefined();
  });
});

describe("Material icon glyph source (#16532)", () => {
  const files: Record<string, string> = {
    "filled/home": svg('<path d="F"/>'),
    "round/home": svg('<path d="R"/>'),
    "two-tone/home": svg('<path d="T" opacity=".3"/>'),
    "two-tone/pill": svg('<defs><path id="a" d="M0 0"/></defs>'),
    "filled/pill": svg('<path d="P"/>'),
  };
  const source = () => {
    const reads: string[] = [];
    const glyphs = new MaterialIconGlyphSource((directory, name) => {
      reads.push(`${directory}/${name}`);
      return files[`${directory}/${name}`];
    });
    return { glyphs, reads };
  };
  const d = (shapes: readonly WebElement[] | undefined) => shapes?.[0]?.attrs.d;

  test("maps contract variants to the package's style directories", () => {
    const { glyphs } = source();
    expect(d(glyphs.glyph("home", "filled"))).toBe("F");
    expect(d(glyphs.glyph("home", "rounded"))).toBe("R");
    expect(d(glyphs.glyph("home", "twoTone"))).toBe("T");
  });

  test("falls back to filled for a style without the glyph, as Android does", () => {
    const { glyphs } = source();
    expect(d(glyphs.glyph("home", "sharp"))).toBe("F");
    expect(d(glyphs.glyph("pill", "twoTone"))).toBe("P");
    expect(glyphs.glyph("nope", "outlined")).toBeUndefined();
  });

  test("reads each file once and never a name outside the snake-case set", () => {
    const { glyphs, reads } = source();
    glyphs.glyph("home", "filled");
    glyphs.glyph("home", "filled");
    expect(glyphs.glyph("../filled/home", "filled")).toBeUndefined();
    expect(glyphs.glyph("Home", "filled")).toBeUndefined();
    expect(reads).toEqual(["filled/home"]);
  });
});

describe("web still icons (#16532)", () => {
  test("an icon draws its glyph tinted by currentColor at 24 px", () => {
    const glyphs = new FakeGlyphSource(new Set(["search"]));
    const still = renderPrototypeStill(
      iconSpec([{ type: "icon", testTag: "i", name: "search", variant: "outlined" }]),
      { glyphs },
    );
    const icon = find(still.element, (node) => node.attrs["data-testid"] === "i")[0]!;
    expect(icon.style).toMatchObject({ width: "24px", height: "24px" });
    expect(icon.style).not.toHaveProperty("border");
    expect(toHtml(icon)).toContain(
      '<svg aria-hidden="true" fill="currentColor" height="100%" viewbox="0 0 24 24" width="100%"><path d="M0 0h6"></path></svg>',
    );
    expect(glyphs.asked).toEqual(["outlined/search"]);
    expect(still.unsupportedNodes).toEqual([]);
  });

  test("a style colour tints the glyph", () => {
    const still = renderPrototypeStill(
      iconSpec([{ type: "icon", testTag: "i", name: "search", style: { color: "#ff0000" } }]),
      { glyphs: new FakeGlyphSource(new Set(["search"])) },
    );
    const icon = find(still.element, (node) => node.attrs["data-testid"] === "i")[0]!;
    expect(icon.style.color).toBe("rgba(255,0,0,1)");
  });

  test("a name without a glyph keeps the placeholder and is listed as iconMissing", () => {
    const still = renderPrototypeStill(
      iconSpec([{ type: "icon", id: "gone", testTag: "i", name: "eco" }]),
      { glyphs: new FakeGlyphSource(new Set()) },
    );
    const icon = find(still.element, (node) => node.attrs["data-testid"] === "i")[0]!;
    expect(icon.children).toEqual(["E"]);
    expect(still.unsupportedNodes).toEqual([
      { type: "icon", id: "gone", path: "root.children[0]", reason: "iconMissing" },
    ]);
  });

  test("only the glyphs a still draws are looked up and inlined", () => {
    const glyphs = new FakeGlyphSource(new Set(["home", "settings", "favorite"]));
    const html = toHtml(
      renderPrototypeStill(
        iconSpec(
          [
            { type: "icon", name: "home" },
            { type: "icon", name: "home" },
            { type: "icon", name: "favorite", visibleWhen: { key: "never", equals: true } },
          ],
          { state: { never: false, unused: "settings" } },
        ),
        { glyphs },
      ).element,
    );
    expect(new Set(glyphs.asked)).toEqual(new Set(["filled/home"]));
    expect(html).toContain("M0 0h4");
    expect(html).not.toContain("M0 0h8");
  });

  test("an iOS frame keeps the placeholder until its glyph set is decided (#16526)", () => {
    const still = renderPrototypeStill(iconSpec([{ type: "icon", testTag: "i", name: "home" }]), {
      platform: "ios",
    });
    expect(toHtml(still.element)).not.toContain("<svg");
    expect(still.unsupportedNodes).toEqual([]);
  });

  test("each screenshot spec inlines under 20 KB of Material glyph data", () => {
    const material = materialIconGlyphs();
    const sizes = Object.values(WEB_SCREENSHOT_SPECS).map((fixture) => {
      const spec: unknown = JSON.parse(readFileSync(join(FIXTURES, fixture), "utf8"));
      const used = new Map<string, string>();
      const recording: PrototypeIconGlyphSource = {
        glyph(name, variant) {
          const shapes = material.glyph(name, variant);
          used.set(`${variant}/${name}`, (shapes ?? []).map((shape) => toHtml(shape)).join(""));
          return shapes;
        },
      };
      const still = renderPrototypeStill(spec, { frame: "pixel-9", glyphs: recording });
      expect(still.unsupportedNodes.filter((node) => node.reason === "iconMissing")).toEqual([]);
      return [...used.values()].reduce((sum, markup) => sum + markup.length, 0);
    });
    expect(Math.max(...sizes)).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThan(20 * 1024);
  });
});
