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

  test("crop and fill cover the fixed axes, a wrapped axis left to the image", () => {
    expect(webImageBox({ asset: "a", heightDp: 200, scale: "crop" }, PIXEL)).toEqual({
      height: 525,
      cover: true,
    });
    expect(webImageBox({ asset: "a", scale: "fill" }, PIXEL).cover).toBe(false);
  });

  test("crop covers a filled axis at the long side, or the portrait width when compact (#16605)", () => {
    const feed = { asset: "a", heightDp: 200, widthFill: true, scale: "crop" } as const;
    expect(webImageBox(feed, PIXEL)).toEqual({ width: 2402, height: 525, cover: true });
    expect(webImageBox(feed, PIXEL, "short")).toEqual({ width: 1082, height: 525, cover: true });
    // A 4000x4000 source is encoded at the landscape width, not its own 4000 px nor 525 px.
    const square = { width: 4000, height: 4000 };
    expect(webImageScaleFactor(square, [webImageBox(feed, PIXEL)])).toBe(2402 / 4000);
    expect(webImageScaleFactor(square, [webImageBox(feed, PIXEL, "short")])).toBe(1082 / 4000);
    const column = { asset: "a", widthDp: 120, heightFill: true, scale: "fill" } as const;
    expect(webImageBox(column, PIXEL, "short")).toEqual({ width: 315, height: 1082, cover: true });
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
    ).toEqual({ asset: "a", widthDp: 120, heightFill: true, scale: "crop" });
  });

  test("a fixed axis excludes the padding on both its sides, as Android's target does", () => {
    const padded = {
      style: {
        width: { dp: 200 },
        height: { dp: 200 },
        padding: { top: 10, bottom: 30, start: 40, end: 20 },
      },
      contentScale: "fill",
    };
    const draw = webImageDraw("a", padded);
    expect(draw).toEqual({ asset: "a", widthDp: 140, heightDp: 160, scale: "fill" });
    expect(webImageBox(draw, { widthDp: 412, heightDp: 915, density: 2 })).toEqual({
      width: 280,
      height: 320,
      cover: true,
    });
    const over = { style: { width: { dp: 20 }, padding: { start: 15, end: 15 } } };
    expect(webImageDraw("a", over).widthDp).toBe(0);
  });

  test("a fixed axis's bounds apply before its padding comes out", () => {
    const raised = {
      style: {
        width: { dp: 200 },
        height: { dp: 200 },
        minWidth: 400,
        minHeight: 400,
        padding: { top: 100, bottom: 100, start: 100, end: 100 },
      },
    };
    expect(webImageDraw("a", raised)).toMatchObject({ widthDp: 200, heightDp: 200 });
    const capped = {
      style: { width: { dp: 200 }, maxWidth: 100, padding: { start: 20, end: 20 } },
    };
    expect(webImageDraw("a", capped).widthDp).toBe(60);
  });

  test("a weighted axis is sized by its share, so it is not fixed for the encode", () => {
    const weighted = {
      style: {
        width: { dp: 200 },
        height: { dp: 100 },
        weight: 1,
        padding: { start: 100, end: 100 },
      },
    };
    expect(webImageDraw("a", weighted, "row")).toEqual({ asset: "a", heightDp: 100, scale: "fit" });
    expect(webImageDraw("a", weighted, "column")).toEqual({ asset: "a", widthDp: 0, scale: "fit" });
    const rendered = still({
      type: "row",
      style: { width: { dp: 600 } },
      children: [{ type: "image", asset: "photo", style: weighted.style }],
    });
    expect(rendered.imageDraws).toEqual([{ asset: "photo", heightDp: 100, scale: "fit" }]);
    const box = webImageBox(rendered.imageDraws[0]!, PIXEL);
    expect(webImageScaleFactor({ width: 1000, height: 500 }, [box])).toBeGreaterThan(0);
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
    expect(rendered.imageDraws).toEqual([
      { asset: "photo", heightDp: 200, widthFill: true, scale: "crop" },
    ]);
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

  test("a padded image's layers fill an in-flow content box inside the padding (#17202)", () => {
    const padding = { top: 10, bottom: 30, start: 40, end: 20 };
    for (const layoutDirection of ["ltr", "rtl"]) {
      const rendered = renderPrototypeStill(
        {
          id: "img",
          window: { placement: { type: "fullscreen" }, layoutDirection },
          root: {
            type: "image",
            asset: "photo",
            contentScale: "fill",
            filter: { tint: "#ff0000" },
            style: { width: { dp: 200 }, height: { dp: 200 }, padding },
          },
        },
        { frame: "pixel-9", imageSlots: new Map([["photo", 3]]) },
      );
      expect(find(rendered.element, (e) => e.attrs.dir === layoutDirection)).not.toEqual([]);
      const node = find(rendered.element, (e) => e.attrs["data-node"] === "image")[0]!;
      // Logical padding, which the window's direction maps to the physical side.
      expect([node.style["padding-inline-start"], node.style["padding-inline-end"]]).toEqual([
        "40px",
        "20px",
      ]);
      const content = node.children[0] as WebElement;
      expect("data-image-content" in content.attrs).toBe(true);
      // In flow, so it takes the node's content box rather than its padding box.
      expect(content.style.position).toBe("relative");
      expect(content.style.inset).toBeUndefined();
      for (const attr of ["data-image", "data-image-tint"]) {
        const layer = find(content, (e) => attr in e.attrs)[0]!;
        expect([layer.style.position, layer.style.inset]).toEqual(["absolute", "0"]);
      }
      expect(rendered.imageDraws).toEqual([
        { asset: "photo", widthDp: 140, heightDp: 160, scale: "fill" },
      ]);
    }
  });

  test("the content box keeps the image's ratio and minimum on a wrapped axis only", () => {
    const content = (style: Record<string, unknown>) =>
      find(
        still({ type: "column", children: [{ type: "image", asset: "photo", style }] }).element,
        (e) => "data-image-content" in e.attrs,
      )[0]!.style;
    const wrappedHeight = content({ width: { dp: 200 }, padding: { start: 40, end: 40 } });
    expect(wrappedHeight["aspect-ratio"]).toBe("var(--pa-3-ar, auto)");
    expect(wrappedHeight["min-width"]).toBeUndefined();
    expect(wrappedHeight["min-height"]).toBe("48px");
    // A fixed height is definite, so the content box takes it and the ratio sizes the width.
    const wrappedWidth = content({ height: { dp: 100 }, padding: { top: 10, bottom: 10 } });
    expect([wrappedWidth.height, wrappedWidth["min-width"]]).toEqual(["100%", "48px"]);
    const filled = content({ width: "fill", padding: { start: 40, end: 40 } });
    expect(filled["min-width"]).toBeUndefined();
    const fixed = content({ width: { dp: 200 }, height: { dp: 200 } });
    expect(fixed["aspect-ratio"]).toBeUndefined();
    // An authored ratio or minimum is the node's own.
    expect(content({ width: { dp: 200 }, aspectRatio: 2 })["aspect-ratio"]).toBeUndefined();
    expect(content({ minHeight: 30 })["min-height"]).toBeUndefined();
    // The minimum yields to the room a maximum leaves inside the padding, and to a weight's zero.
    const capped = content({
      width: { dp: 200 },
      maxHeight: 100,
      padding: { top: 40, bottom: 40 },
    });
    expect(capped["min-height"]).toBe("min(48px, calc(100px - 40px - 40px))");
    const weighted = find(
      still({
        type: "row",
        children: [{ type: "image", asset: "photo", style: { weight: 1, height: { dp: 40 } } }],
      }).element,
      (e) => "data-image-content" in e.attrs,
    )[0]!.style;
    expect(weighted["min-width"]).toBeUndefined();
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
