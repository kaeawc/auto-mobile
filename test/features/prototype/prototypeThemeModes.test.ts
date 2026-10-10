import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prototypeThemeModeFields } from "../../../src/features/prototype/prototypeThemeModes";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const fixtures = join(import.meta.dir, "../../fixtures/prototype-spec/valid");
const load = (name: string): unknown => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

describe("prototypeThemeModeFields", () => {
  test("lists every per-mode field of the colour fixture in document order", () => {
    expect(prototypeThemeModeFields(load("theme-modes-colors.json"))).toEqual([
      "theme.colors.light",
      "theme.colors.dark",
      "window.placement.scrim",
      "root.style.background",
      "root.style.shadowColor",
      "root.style.border.color",
      "root.style.gradient.stops[0].color",
      "root.style.gradient.stops[1].color",
      "root.styleWhen[0].style.background",
      "root.children[0].style.color",
      "root.children[1].scrim",
      "root.children[2].scrim",
    ]);
  });

  test("lists image and navigation item pairs, not plain asset ids", () => {
    expect(prototypeThemeModeFields(load("theme-modes-images.json"))).toEqual([
      "root.children[0].asset",
      "root.children[1].asset",
      "root.children[3].items[0].image",
    ]);
  });

  test("every shared fixture written before per-mode forms needs no capability", () => {
    const older = readdirSync(fixtures).filter(
      (name) => name.endsWith(".json") && !name.startsWith("theme-modes-"),
    );
    expect(older.length).toBeGreaterThan(20);
    for (const name of older) {
      expect([name, prototypeThemeModeFields(load(name))]).toEqual([name, []]);
    }
  });

  test("a hex scrim, hex gradient stops and role style colours stay ungated", () => {
    const spec = {
      id: "a",
      window: { placement: { type: "fullscreen", scrim: "#66000000" } },
      theme: { colors: { seed: "#6750A4", surface: "#FFFFFF" } },
      root: {
        type: "text",
        text: "x",
        style: {
          background: "surface",
          color: "onSurface",
          gradient: { type: "radial", stops: [{ color: "#000000" }, { color: "#FFFFFF" }] },
        },
      },
    };
    expect(validatePrototypeSpec(spec).success).toBe(true);
    expect(prototypeThemeModeFields(spec)).toEqual([]);
  });

  test("a pair naming one asset costs one image and two different assets cost two", () => {
    const row = (assets: unknown[]) => ({
      id: "a",
      window: { placement: { type: "fullscreen" } },
      root: { type: "row", children: assets.map((asset) => ({ type: "image", asset })) },
    });
    const same = { light: "one", dark: "one" };
    const differing = (index: number) => ({ light: `l${index}`, dark: `d${index}` });
    expect(validatePrototypeSpec(row(Array.from({ length: 32 }, () => same))).success).toBe(true);
    const sixteen = Array.from({ length: 16 }, (_, index) => differing(index));
    expect(validatePrototypeSpec(row(sixteen)).success).toBe(true);
    expect(validatePrototypeSpec(row([...sixteen, "plain"]))).toEqual({
      success: false,
      error: { path: "root.children[16]", message: "Image limit exceeded" },
    });
  });
});
