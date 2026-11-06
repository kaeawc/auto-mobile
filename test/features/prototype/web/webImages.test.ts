import { describe, expect, test } from "bun:test";
import {
  webImageAsset,
  webImageBox,
  webImageDraw,
  webImageRule,
  webImageScaleFactor,
} from "../../../../src/features/prototype/web/webImages";
import { toHtml } from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";
import type { WebElement } from "../../../../src/features/prototype/web/webNodes";

const PIXEL = { widthDp: 412, heightDp: 915, density: 2.625 };
const identity = (text: string) => text;

function find(element: WebElement, predicate: (node: WebElement) => boolean): WebElement[] {
  const children = element.children.filter(
    (child): child is WebElement => typeof child !== "string",
  );
  return [...(predicate(element) ? [element] : []), ...children.flatMap((c) => find(c, predicate))];
}

const still = (root: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  renderPrototypeStill(
    { id: "img", window: { placement: { type: "fullscreen" } }, root, ...extra },
    { frame: "pixel-9", imageSlots: new Map([["photo", 3]]) },
  );

describe("webImageAsset", () => {
  test("a light/dark pair picks the mode's side", () => {
    expect(webImageAsset({ light: "l", dark: "d" }, "dark", identity)).toBe("d");
    expect(webImageAsset({ light: "l", dark: "d" }, "light", identity)).toBe("l");
  });

  test("binds the id and ignores a missing or empty one", () => {
    expect(webImageAsset("{item.photo}", "light", () => "p1")).toBe("p1");
    expect(webImageAsset("{x}", "light", () => "")).toBeUndefined();
    expect(webImageAsset(undefined, "light", identity)).toBeUndefined();
  });
});

describe("webImageBox", () => {
  test("fit: fixed dp axes at the frame's density, others bounded by the long side", () => {
    expect(webImageBox({ asset: "a", widthDp: 100, scale: "fit" }, PIXEL)).toEqual({
      width: 263,
      height: 2402,
      cover: false,
    });
  });

  test("crop and fill cover only the fixed axes", () => {
    expect(webImageBox({ asset: "a", heightDp: 200, scale: "crop" }, PIXEL)).toEqual({
      height: 525,
      cover: true,
    });
    expect(webImageBox({ asset: "a", scale: "fill" }, PIXEL).cover).toBe(false);
  });
});

describe("webImageScaleFactor", () => {
  const source = { width: 4000, height: 3000 };

  test("fits inside a box, covers a crop box, and takes the largest need", () => {
    expect(webImageScaleFactor(source, [{ width: 400, height: 400, cover: false }])).toBe(0.1);
    expect(webImageScaleFactor(source, [{ width: 400, height: 600, cover: true }])).toBe(0.2);
    expect(
      webImageScaleFactor(source, [
        { width: 400, height: 400, cover: false },
        { width: 800, cover: true },
      ]),
    ).toBe(0.2);
  });

  test("never enlarges", () => {
    expect(webImageScaleFactor(source, [{ width: 8000, height: 8000, cover: false }])).toBe(1);
  });
});

describe("webImageDraw and webImageRule", () => {
  test("records fixed dp sizes and the content scale", () => {
    expect(
      webImageDraw("a", { style: { width: { dp: 120 }, height: "fill" }, contentScale: "crop" }),
    ).toEqual({ asset: "a", widthDp: 120, scale: "crop" });
  });

  test("the rule sets the slot's image, transparent placeholder, aspect ratio and tint switch", () => {
    const rule = webImageRule(2, {
      id: "a",
      bytes: new Uint8Array([1, 2, 3]),
      width: 4,
      height: 3,
    });
    expect(rule).toBe(
      ":root{--pa-2:url(data:image/webp;base64,AQID);--pa-2-bg:transparent;--pa-2-ar:4/3;--pa-2-on:1}",
    );
  });
});

describe("an image with an inlinable asset", () => {
  test("draws the slot's image at its content scale, clipped by its corners", () => {
    const rendered = still({
      type: "image",
      id: "hero",
      asset: "photo",
      contentScale: "crop",
      style: { width: "fill", height: { dp: 200 }, cornerRadius: 16 },
    });
    const node = find(rendered.element, (e) => e.attrs["data-node"] === "image")[0]!;
    expect(node.style["background-color"]).toBe("var(--pa-3-bg, rgba(231,224,236,1))");
    expect(node.style.overflow).toBe("hidden");
    expect(node.style["aspect-ratio"]).toBeUndefined();
    const layer = find(node, (e) => "data-image" in e.attrs)[0]!;
    expect(layer.style["background-image"]).toBe("var(--pa-3)");
    expect(layer.style["background-size"]).toBe("cover");
    expect(rendered.unsupportedNodes).toEqual([
      { type: "image", id: "hero", path: "root", reason: "assetOverBudget", asset: "photo" },
    ]);
    expect(rendered.imageDraws).toEqual([{ asset: "photo", heightDp: 200, scale: "crop" }]);
  });

  test("keeps the image's aspect ratio on an axis left to wrap", () => {
    const rendered = still({
      type: "column",
      children: [{ type: "image", asset: "photo", style: { width: "fill" } }],
    });
    expect(toHtml(rendered.element)).toContain("aspect-ratio:var(--pa-3-ar, auto)");
  });

  test("saturates the image, then multiplies a tint masked by it", () => {
    const rendered = still({
      type: "image",
      asset: "photo",
      filter: { saturation: 0.5, tint: "#ff0000" },
    });
    const layer = find(rendered.element, (e) => "data-image" in e.attrs)[0]!;
    expect(layer.style.filter).toBe("saturate(0.5)");
    const tint = find(rendered.element, (e) => "data-image-tint" in e.attrs)[0]!;
    expect(tint.style).toMatchObject({
      "background-color": "rgba(255,0,0,1)",
      "mix-blend-mode": "multiply",
      "mask-image": "var(--pa-3)",
      "mask-size": "contain",
      opacity: "var(--pa-3-on, 0)",
    });
  });

  test("a fixed dp axis keeps its size; only a wrapped axis gets the 48px minimum (#17241)", () => {
    // Android sizes an image with `size(24.dp)` at 24 dp: its 24 dp default minimum never applies
    // to an authored size, so a 48px CSS minimum must not either.
    const icon = (
      asset: string,
      style: Record<string, unknown>,
    ): Readonly<Record<string, string | undefined>> =>
      find(
        still({ type: "image", asset, style }).element,
        (e) => e.attrs["data-node"] === "image",
      )[0]!.style;
    for (const asset of ["photo", "missing"]) {
      const fixed = icon(asset, { width: { dp: 24 }, height: { dp: 24 } });
      expect([fixed.width, fixed.height, fixed["min-width"], fixed["min-height"]]).toEqual([
        "24px",
        "24px",
        undefined,
        undefined,
      ]);
      const half = icon(asset, { width: { dp: 24 } });
      expect([half["min-width"], half["min-height"]]).toEqual([undefined, "48px"]);
      const authored = icon(asset, { width: { dp: 24 }, height: { dp: 24 }, minWidth: 30 });
      expect(authored["min-width"]).toBe("30px");
    }
  });

  test("a translucent tint draws its opaque colour and scales the image's alpha", () => {
    const rendered = still({
      type: "image",
      asset: "photo",
      filter: { tint: "#80FF0000" },
    });
    const group = find(rendered.element, (e) => "data-image-alpha" in e.attrs)[0]!;
    expect(group.style).toEqual({ position: "absolute", inset: "0", opacity: "0.502" });
    expect(find(group, (e) => "data-image" in e.attrs)).toHaveLength(1);
    const tint = find(group, (e) => "data-image-tint" in e.attrs)[0]!;
    expect(tint.style["background-color"]).toBe("rgba(255,0,0,1)");
  });

  test("a fully transparent tint hides the image, as Modulate does", () => {
    const rendered = still({ type: "image", asset: "photo", filter: { tint: "#00FFFFFF" } });
    const group = find(rendered.element, (e) => "data-image-alpha" in e.attrs)[0]!;
    expect(group.style.opacity).toBe("0");
  });

  test("an opaque tint adds no alpha group", () => {
    const rendered = still({ type: "image", asset: "photo", filter: { tint: "#ff0000" } });
    expect(find(rendered.element, (e) => "data-image-alpha" in e.attrs)).toEqual([]);
  });

  test("binds a repeat item's asset id", () => {
    const rendered = still({
      type: "column",
      repeat: { as: "item", items: [{ photo: "photo" }, { photo: "other" }] },
      children: [{ type: "image", asset: "{item.photo}" }],
    });
    expect(rendered.unsupportedNodes.map((node) => [node.asset, node.reason])).toEqual([
      ["photo", "assetOverBudget"],
      ["other", "assetNotInlined"],
    ]);
    expect(rendered.imageDraws.map((draw) => draw.asset)).toEqual(["photo", "other"]);
  });
});
