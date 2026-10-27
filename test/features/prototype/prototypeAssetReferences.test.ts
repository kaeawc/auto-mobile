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

test("upload file slots include raw and multipart assets without scanning opaque literals", () => {
  const raw = {
    type: "request",
    method: "POST",
    url: "https://example.com",
    body: { file: { asset: "raw" }, contentType: "image/png" },
  };
  const multipart = {
    ...raw,
    body: {
      multipart: [
        { name: "photo", file: { asset: "part" } },
        { name: "caption", value: { value: { file: { asset: "opaque-part" } } } },
      ],
    },
  };
  const spec = {
    data: { type: "request", body: { file: { asset: "opaque-data" } } },
    root: {
      type: "button",
      label: "Upload",
      onTap: [
        {
          type: "startTimer",
          id: "upload",
          afterMs: 100,
          actions: [{ ...raw, onSuccess: [multipart] }],
        },
      ],
    },
    components: {
      upload: {
        root: {
          type: "button",
          label: "Upload",
          onTap: [
            { ...raw, body: { value: { file: { asset: "opaque-body" } } } },
            { ...raw, body: { file: { asset: "component-upload" }, contentType: "image/png" } },
          ],
        },
      },
    },
  };
  const references = collectPrototypeAssetReferences(spec);
  expect(references.images).toEqual(new Set(["raw", "part", "component-upload"]));
  expect(references.fonts.size).toBe(0);
  const mirrored = new Set<string>();
  collectPrototypeStrings(spec, new Set(), mirrored);
  expect(mirrored).toEqual(references.images);
});
