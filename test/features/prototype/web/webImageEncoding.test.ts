import { describe, expect, test } from "bun:test";
import {
  buildPrototypeWebPageWithImages,
  encodePrototypeWebImages,
  type PrototypeWebAssetSource,
  type PrototypeWebImageEncoder,
} from "../../../../src/features/prototype/web/webImageEncoding";
import {
  buildPrototypeWebPage,
  type PrototypeWebPageInput,
} from "../../../../src/features/prototype/web/webPage";
import type { WebImageBox } from "../../../../src/features/prototype/web/webImages";

const photo = (asset: string, height = 200) => ({
  type: "image",
  id: asset,
  asset,
  contentScale: "crop",
  style: { width: "fill", height: { dp: height } },
});
const feed = (...assets: string[]) => ({
  id: "feed",
  window: { placement: { type: "fullscreen" } },
  root: { type: "column", children: assets.map((asset) => photo(asset)) },
});
const page = (
  revisions: unknown[],
  extra: Partial<PrototypeWebPageInput> = {},
): PrototypeWebPageInput => ({
  title: "Feed",
  variants: [
    {
      id: "feed",
      label: "Feed",
      revisions: revisions.map((spec, index) => ({
        revision: index + 1,
        operation: "show" as const,
        spec,
      })),
    },
  ],
  frame: "pixel-9",
  ...extra,
});

/** Assets of `size` bytes each; an id starting with "font" is a font. */
function source(ids: readonly string[]): PrototypeWebAssetSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get: async (id) => {
      reads.push(id);
      if (!ids.includes(id)) {
        return undefined;
      }
      return {
        mimeType: id.startsWith("font") ? "font/ttf" : "image/png",
        bytes: Uint8Array.of(1),
      };
    },
  };
}

/** Encodes every asset to `size` bytes and records the boxes it was asked for. */
function encoder(size: number): PrototypeWebImageEncoder & { boxes: WebImageBox[][] } {
  const boxes: WebImageBox[][] = [];
  return {
    boxes,
    encode: async (_bytes, requested) => {
      boxes.push([...requested]);
      return { bytes: new Uint8Array(size), width: 4, height: 3 };
    },
  };
}

describe("buildPrototypeWebPage with images", () => {
  test("inlines each image once as a page rule and drops its placeholder entry", () => {
    const input = page([feed("a", "b")], {
      images: [
        { id: "a", bytes: new Uint8Array(30), width: 4, height: 3 },
        { id: "b", bytes: new Uint8Array(30), width: 4, height: 3 },
      ],
    });
    const built = buildPrototypeWebPage(input);
    expect(built.inlinedImages).toEqual(["a", "b"]);
    expect(built.unsupportedNodes).toEqual([]);
    // Both orientations reference the slot; the bytes appear once, in the head.
    expect(built.html.split("--pa-0:url(data:image/webp;base64,").length).toBe(2);
    expect(built.html.split("var(--pa-0)").length).toBe(3);
  });

  test("an asset that does not fit keeps its placeholder with reason assetOverBudget", () => {
    const images = [
      { id: "a", bytes: new Uint8Array(300), width: 4, height: 3 },
      { id: "b", bytes: new Uint8Array(3000), width: 4, height: 3 },
    ];
    const whole = buildPrototypeWebPage(page([feed("a", "b")], { images }));
    // b's rule alone is about 4 KB of base64, a's about 400 bytes.
    const maxBytes = Buffer.byteLength(whole.html) - 2000;
    const built = buildPrototypeWebPage(page([feed("a", "b")], { images, maxBytes }));
    expect(built.inlinedImages).toEqual(["a"]);
    expect(built.unsupportedNodes).toEqual([
      { type: "image", id: "b", path: "root.children[1]", reason: "assetOverBudget", asset: "b" },
    ]);
  });

  test("an asset the host has no bytes for is not inlined", () => {
    const built = buildPrototypeWebPage(page([feed("a")]));
    expect(built.unsupportedNodes.map((node) => node.reason)).toEqual(["assetNotInlined"]);
    expect(built.inlinedImages).toEqual([]);
  });

  test("requests the newest revision's assets first, with each box once", () => {
    const built = buildPrototypeWebPage(page([feed("old", "shared"), feed("shared", "new")]));
    expect(built.imageRequests.map((request) => request.id)).toEqual(["shared", "new", "old"]);
    // 200 dp crop at 2.625x, the same in both orientations.
    expect(built.imageRequests[0]!.boxes).toEqual([{ height: 525, cover: true }]);
  });

  test("the same images yield the same bytes", () => {
    const images = [{ id: "a", bytes: new Uint8Array(30), width: 4, height: 3 }];
    expect(buildPrototypeWebPage(page([feed("a")], { images })).html).toBe(
      buildPrototypeWebPage(page([feed("a")], { images })).html,
    );
  });
});

describe("budget order for a stack's other screens (#17241)", () => {
  test("charges each screen's images before the next screen's markup", () => {
    const stack = {
      id: "stacked",
      root: {
        type: "stack",
        start: "a",
        screens: {
          a: { type: "text", text: "start" },
          b: { type: "image", asset: "pb", style: { width: { dp: 100 }, height: { dp: 100 } } },
          c: { type: "text", text: "x".repeat(4000) },
        },
      },
    };
    const images = [{ id: "pb", bytes: new Uint8Array(3000), width: 4, height: 3 }];
    const whole = buildPrototypeWebPage(page([stack], { images }));
    expect(whole.inlinedImages).toEqual(["pb"]);
    // One byte short: either screen c's markup or b's image goes. Screen b comes first, so its
    // image is charged before c is considered.
    const built = buildPrototypeWebPage(
      page([stack], { images, maxBytes: Buffer.byteLength(whole.html) - 1 }),
    );
    expect(built.inlinedImages).toEqual(["pb"]);
    expect([...built.html.matchAll(/data-screen="([^"]*)"/g)].map((match) => match[1])).toEqual([
      "a",
      "a",
      "b",
      "b",
    ]);
  });
});

describe("encodePrototypeWebImages", () => {
  test("skips assets without image bytes and keeps request order", async () => {
    const assets = source(["b", "font", "a"]);
    const { images } = await encodePrototypeWebImages(
      [
        { id: "a", boxes: [] },
        { id: "missing", boxes: [] },
        { id: "font", boxes: [] },
        { id: "b", boxes: [] },
      ],
      assets,
      encoder(3),
    );
    expect(images.map((image) => image.id)).toEqual(["a", "b"]);
  });

  test("an asset the encoder rejects keeps its placeholder", async () => {
    const failing: PrototypeWebImageEncoder = {
      encode: async () => {
        throw new Error("corrupt");
      },
    };
    expect(
      (await encodePrototypeWebImages([{ id: "a", boxes: [] }], source(["a"]), failing)).images,
    ).toEqual([]);
  });

  test("skips only an image whose data URI alone exceeds the page, then keeps going", async () => {
    const assets = source(["big", "small"]);
    const sized: PrototypeWebImageEncoder = {
      encode: async (bytes) => ({
        bytes: new Uint8Array(bytes.length === 2 ? 300 : 30),
        width: 4,
        height: 3,
      }),
    };
    const bigFirst: PrototypeWebAssetSource = {
      get: async (id) =>
        (await assets.get(id)) && {
          mimeType: "image/png",
          bytes: id === "big" ? Uint8Array.of(1, 2) : Uint8Array.of(1),
        },
    };
    const { images, overBudget } = await encodePrototypeWebImages(
      ["big", "small"].map((id) => ({ id, boxes: [] })),
      bigFirst,
      sized,
      { maxBytes: 100 },
    );
    expect(images.map((image) => image.id)).toEqual(["small"]);
    expect([...overBudget]).toEqual(["big"]);
  });
});

describe("buildPrototypeWebPageWithImages", () => {
  test("encodes drawn assets at the boxes the frame draws them and inlines them", async () => {
    const encode = encoder(30);
    const built = await buildPrototypeWebPageWithImages(
      page([feed("a", "b")]),
      source(["a", "b"]),
      encode,
    );
    expect(built.inlinedImages).toEqual(["a", "b"]);
    expect(encode.boxes).toEqual([[{ height: 525, cover: true }], [{ height: 525, cover: true }]]);
  });

  test("keeps the placeholder page when image markup alone overflows the budget", async () => {
    const input = page([feed("a", "b")]);
    const placeholders = buildPrototypeWebPage(input);
    // Room for the placeholder page and its shell's history list, not for four image views'
    // layers (each several hundred bytes).
    const built = await buildPrototypeWebPageWithImages(
      { ...input, maxBytes: Buffer.byteLength(placeholders.html) + 200 },
      source(["a", "b"]),
      encoder(3),
    );
    expect(built.html).toBe(placeholders.html);
    expect(built.inlinedImages).toEqual([]);
    expect(built.unsupportedNodes.map((node) => node.reason)).toEqual([
      "assetOverBudget",
      "assetOverBudget",
    ]);
  });

  test("an image whose data URI alone exceeds the page is reported assetOverBudget (#17241)", async () => {
    const input = page([feed("huge", "small")]);
    const maxBytes = Buffer.byteLength(buildPrototypeWebPage(input).html) + 4000;
    const sized: PrototypeWebImageEncoder = {
      encode: async (bytes) => ({
        bytes: new Uint8Array(bytes.length === 2 ? maxBytes : 30),
        width: 4,
        height: 3,
      }),
    };
    const assets: PrototypeWebAssetSource = {
      get: async (id) => ({
        mimeType: "image/png",
        bytes: id === "huge" ? Uint8Array.of(1, 2) : Uint8Array.of(1),
      }),
    };
    const built = await buildPrototypeWebPageWithImages({ ...input, maxBytes }, assets, sized);
    expect(built.inlinedImages).toEqual(["small"]);
    expect(built.unsupportedNodes).toEqual([
      {
        type: "image",
        id: "huge",
        path: "root.children[0]",
        reason: "assetOverBudget",
        asset: "huge",
      },
    ]);
    // With nothing else to inline, the placeholder page still reports why.
    const alone = page([feed("huge")]);
    const placeholders = await buildPrototypeWebPageWithImages(
      { ...alone, maxBytes },
      assets,
      sized,
    );
    expect(placeholders.unsupportedNodes.map((node) => node.reason)).toEqual(["assetOverBudget"]);
  });

  test("asks the encoder to apply EXIF orientation only for an iOS frame (#17241)", async () => {
    const orientations: boolean[] = [];
    const recording: PrototypeWebImageEncoder = {
      encode: async (_bytes, _boxes, options) => {
        orientations.push(options.applyExifOrientation);
        return { bytes: new Uint8Array(3), width: 4, height: 3 };
      },
    };
    await buildPrototypeWebPageWithImages(page([feed("a")]), source(["a"]), recording);
    await buildPrototypeWebPageWithImages(
      page([feed("a")], { frame: "iphone-16" }),
      source(["a"]),
      recording,
    );
    expect(orientations).toEqual([false, true]);
  });

  test("a page that draws no image is built once, without asking for bytes", async () => {
    const assets = source([]);
    const spec = { id: "t", root: { type: "text", text: "hi" } };
    const built = await buildPrototypeWebPageWithImages(page([spec]), assets, encoder(1));
    expect(built.html).toBe(buildPrototypeWebPage(page([spec])).html);
    expect(assets.reads).toEqual([]);
  });
});
