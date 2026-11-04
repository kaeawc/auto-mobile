import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrototypeSpecRevisions } from "../../../../src/features/prototype/prototypeSpecRevisions";
import {
  prototypeEmbedGlyphs,
  prototypeGlyphKeys,
} from "../../../../src/features/prototype/web/prototypeEmbedGlyphs";
import {
  prototypeEmbedEnvelope,
  readPrototypeEmbedResource,
} from "../../../../src/features/prototype/web/prototypeEmbedResource";
import { materialIconGlyphs } from "../../../../src/features/prototype/web/materialIconGlyphs";
import {
  type PrototypeIconGlyphSource,
  type PrototypeIconVariant,
} from "../../../../src/features/prototype/web/webIconGlyphs";
import { el, type WebElement } from "../../../../src/features/prototype/web/webNodes";
import { FakeTimer } from "../../../fakes/FakeTimer";

const FIXTURES = join(import.meta.dir, "../../../fixtures/prototype-spec/valid");

/** One path per known name (its length in `d`), recording every lookup. */
class FakeGlyphSource implements PrototypeIconGlyphSource {
  readonly asked: string[] = [];
  constructor(private readonly known: ReadonlySet<string>) {}
  glyph(name: string, variant: PrototypeIconVariant): readonly WebElement[] | undefined {
    this.asked.push(`${variant}/${name}`);
    return this.known.has(name) ? [el("path", { attrs: { d: `M0 0h${name.length}` } })] : undefined;
  }
}

const iconSpec = {
  id: "icons",
  state: { tab: 0, favorite: "favorite", label: "not an icon", nested: { deep: ["star"] } },
  data: { rows: [{ icon: "delete" }, { title: "Hello" }] },
  root: {
    type: "column",
    children: [
      { type: "icon", name: "search", variant: "outlined" },
      { type: "icon", name: "home" },
      { type: "button", text: "Add", icon: "add" },
      { type: "textField", stateKey: "q", leadingIcon: "mail" },
      { type: "text", text: "settings" },
    ],
  },
};

describe("prototype embed glyph keys (#16609)", () => {
  test("collects icon fields in their variant and state/data names in every used variant", () => {
    expect(prototypeGlyphKeys(iconSpec)).toEqual([
      "filled/add",
      "filled/delete",
      "filled/favorite",
      "filled/home",
      "filled/mail",
      "filled/star",
      "outlined/delete",
      "outlined/favorite",
      "outlined/search",
      "outlined/star",
    ]);
  });

  test("a text that happens to be an icon name is not an icon field", () => {
    expect(prototypeGlyphKeys(iconSpec)).not.toContain("filled/settings");
  });

  test("a filter chip names the check it draws while selected, selected now or not", () => {
    const chips = (stateKey?: string) =>
      prototypeGlyphKeys({
        id: "chips",
        state: { on: false },
        root: { type: "chip", label: "Wifi", ...(stateKey ? { stateKey } : {}) },
      });
    expect(chips("on")).toEqual(["filled/check"]);
    expect(chips()).toEqual([]);
    const fixture: Record<string, unknown> = JSON.parse(
      readFileSync(join(FIXTURES, "material-slider-chip-card.json"), "utf8"),
    );
    expect(prototypeGlyphKeys(fixture)).toContain("filled/check");
  });

  test("a spec without icons names no glyph", () => {
    expect(prototypeGlyphKeys({ id: "t", root: { type: "text", text: "home" } })).toEqual([]);
  });

  test("nested icon slots are found: app bar actions and list trailing icons", () => {
    const keys = prototypeGlyphKeys({
      id: "nested",
      root: {
        type: "column",
        children: [
          {
            type: "topAppBar",
            title: "T",
            actions: [{ icon: "share", label: "Share" }],
          },
          { type: "listItem", headline: "H", trailing: { type: "icon", name: "chevron_right" } },
        ],
      },
    });
    expect(keys).toEqual(expect.arrayContaining(["filled/share", "filled/chevron_right"]));
  });
});

describe("prototype embed glyph map (#16609)", () => {
  test("carries exactly the glyphs the spec can name and lists those with none", () => {
    const source = new FakeGlyphSource(new Set(["search", "home", "add", "mail", "favorite"]));
    const { glyphs, iconMissing } = prototypeEmbedGlyphs(iconSpec, source);
    expect(glyphs).toEqual({
      "filled/add": '<path d="M0 0h3"></path>',
      "filled/favorite": '<path d="M0 0h8"></path>',
      "filled/home": '<path d="M0 0h4"></path>',
      "filled/mail": '<path d="M0 0h4"></path>',
      "outlined/favorite": '<path d="M0 0h8"></path>',
      "outlined/search": '<path d="M0 0h6"></path>',
    });
    expect(iconMissing).toEqual([
      "filled/delete",
      "filled/star",
      "outlined/delete",
      "outlined/star",
    ]);
    expect(source.asked).toEqual(prototypeGlyphKeys(iconSpec));
  });

  test("the envelope adds glyphs and iconMissing only when the spec names icons", () => {
    const source = new FakeGlyphSource(new Set(["home"]));
    const plain = prototypeEmbedEnvelope({ id: "t", root: { type: "text", text: "x" } }, source);
    expect(plain).not.toHaveProperty("glyphs");
    expect(plain).not.toHaveProperty("iconMissing");
    const spec = { id: "i", root: { type: "icon", name: "home" } };
    expect(prototypeEmbedEnvelope(spec, source)).toMatchObject({
      version: 1,
      glyphs: { "filled/home": '<path d="M0 0h4"></path>' },
    });
    expect(prototypeEmbedEnvelope(spec, source)).not.toHaveProperty("iconMissing");
  });

  test("the embed resource serves the glyph map from the injected source", () => {
    const store = new PrototypeSpecRevisions(new FakeTimer());
    store.recordShow("i", { spec: { id: "i", root: { type: "icon", name: "eco" } } });
    const embed = readPrototypeEmbedResource(
      store,
      { id: "i" },
      "v",
      new FakeGlyphSource(new Set()),
    );
    expect(JSON.parse(embed.text).iconMissing).toEqual(["filled/eco"]);
    expect(JSON.parse(embed.text)).not.toHaveProperty("glyphs");
    const found = readPrototypeEmbedResource(
      store,
      { id: "i" },
      "v",
      new FakeGlyphSource(new Set(["eco"])),
    );
    expect(JSON.parse(found.text).glyphs).toEqual({ "filled/eco": '<path d="M0 0h3"></path>' });
    expect(JSON.parse(found.text)).not.toHaveProperty("iconMissing");
  });

  test("the component-gallery envelope stays under 20 KB of Material glyph data", () => {
    const glyphBytes = (fixture: string) => {
      const spec: Record<string, unknown> = JSON.parse(
        readFileSync(join(FIXTURES, `${fixture}.json`), "utf8"),
      );
      const { glyphs } = prototypeEmbedGlyphs(spec, materialIconGlyphs());
      return Object.values(glyphs).reduce((sum, markup) => sum + markup.length, 0);
    };
    expect(glyphBytes("component-gallery")).toBeLessThan(20 * 1024);
    // A spec that names real icons reads real glyphs, so the budget is not met vacuously.
    expect(glyphBytes("doc-example-2")).toBeGreaterThan(0);
    expect(glyphBytes("doc-example-2")).toBeLessThan(20 * 1024);
  });
});
