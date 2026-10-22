import { expect, test } from "bun:test";
import {
  collectPrototypeAssetReferences,
  collectPrototypeStrings,
} from "../../../src/features/prototype/prototypeAssetReferences";

test("one shared collector covers themed images, nav items and all font style slots", () => {
  const spec = {
    data: { asset: "opaque-data", fontFamily: { asset: "opaque-font" } },
    root: {
      type: "column",
      children: [
        {
          type: "image",
          asset: { light: "light", dark: "dark" },
          style: { fontFamily: { asset: "node-font" } },
          styleWhen: [{ style: { fontFamily: { asset: "conditional-font" } } }],
        },
        {
          type: "tabBar",
          items: [{ image: "nav" }, { image: { light: "nav-light", dark: "nav-dark" } }],
        },
        {
          type: "text",
          spans: [{ text: "hello", style: { fontFamily: { asset: "span-font" } } }],
          onTap: { type: "emit", payload: { asset: "opaque-payload" } },
        },
      ],
    },
    components: { sample: { root: { type: "image", asset: "component" } } },
  };
  const result = collectPrototypeAssetReferences(spec);
  expect([...result.images].sort()).toEqual([
    "component",
    "dark",
    "light",
    "nav",
    "nav-dark",
    "nav-light",
  ]);
  expect([...result.fonts].sort()).toEqual(["conditional-font", "node-font", "span-font"]);
  const strings = new Set<string>();
  const references = new Set<string>();
  collectPrototypeStrings(spec, strings, references);
  expect(strings.has("opaque-data")).toBe(true);
  expect(references.has("opaque-data")).toBe(false);
  expect(references).toEqual(new Set([...result.images, ...result.fonts]));
});
