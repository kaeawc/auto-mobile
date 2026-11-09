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
    // 200 dp crop at 2.625x, its filled width at the long side, or the portrait width when compact.
    expect(built.imageRequests[0]!.boxes).toEqual([{ width: 2423, height: 525, cover: true }]);
    expect(built.imageRequests[0]!.compactBoxes).toEqual([
      { width: 1079, height: 525, cover: true },
    ]);
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
    const long = [{ width: 2423, height: 525, cover: true }];
    expect(encode.boxes).toEqual([long, long]);
  });

  /** Encodes a long-side box (2423 px wide) to `large` bytes and any other box to `small`. */
  function sizedByBox(large: number, small: number) {
    const calls: string[] = [];
    const encode: PrototypeWebImageEncoder = {
      encode: async (bytes, boxes) => {
        const wide = boxes.some((box) => (box.width ?? 0) > 2000);
        calls.push(wide ? "long" : "compact");
        return { bytes: new Uint8Array(wide ? large : small), width: 4, height: 3 };
      },
    };
    return { calls, encode };
  }

  test("re-encodes at the portrait width when the long-side images do not all fit (#16605)", async () => {
    const input = page([feed("a", "b", "c")]);
    const placeholders = Buffer.byteLength(buildPrototypeWebPage(input).html);
    // Room for one long-side image (about 4 KB of base64) or all three compact ones, not more.
    const maxBytes = placeholders + 9000;
    const { calls, encode } = sizedByBox(3000, 600);
    const built = await buildPrototypeWebPageWithImages(
      { ...input, maxBytes },
      source(["a", "b", "c"]),
      encode,
    );
    expect(built.inlinedImages).toEqual(["a", "b", "c"]);
    expect(built.unsupportedNodes).toEqual([]);
    expect(Buffer.byteLength(built.html)).toBeLessThanOrEqual(maxBytes);
    expect(calls).toEqual(["long", "long", "long", "compact", "compact", "compact"]);
    // The first image keeps its long-side encode: its 3000 bytes are in the page.
    const sizes = [...built.html.matchAll(/base64,([^)]*)\)/g)].map(
      (m) => Buffer.from(m[1]!, "base64").length,
    );
    expect(sizes).toEqual([3000, 600, 600]);
  });

  test("keeps every long-side encode when they all fit (#16605)", async () => {
    const { calls, encode } = sizedByBox(3000, 600);
    const built = await buildPrototypeWebPageWithImages(
      page([feed("a", "b")]),
      source(["a", "b"]),
      encode,
    );
    expect(built.inlinedImages).toEqual(["a", "b"]);
    expect(calls).toEqual(["long", "long"]);
  });

  test("a fixed-size image has no compact encode and keeps its overflow placeholder (#16605)", async () => {
    const fixed = (asset: string) => ({
      type: "image",
      id: asset,
      asset,
      contentScale: "crop",
      style: { width: { dp: 100 }, height: { dp: 100 } },
    });
    const spec = { id: "grid", root: { type: "column", children: [fixed("a"), fixed("b")] } };
    const input = page([spec]);
    expect(buildPrototypeWebPage(input).imageRequests[0]!.compactBoxes).toBeUndefined();
    const maxBytes = Buffer.byteLength(buildPrototypeWebPage(input).html) + 6000;
    const encode = encoder(3000);
    const built = await buildPrototypeWebPageWithImages(
      { ...input, maxBytes },
      source(["a", "b"]),
      encode,
    );
    expect(built.inlinedImages).toEqual(["a"]);
    expect(encode.boxes).toHaveLength(2);
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

  test("an asset cache that fails to read keeps the placeholder page", async () => {
    const input = page([feed("a", "b")]);
    const unreadable: PrototypeWebAssetSource = {
      get: async (id) => {
        if (id === "a") {
          throw new Error("EACCES: permission denied");
        }
        return { mimeType: "image/png", bytes: Uint8Array.of(1) };
      },
    };
    const built = await buildPrototypeWebPageWithImages(input, unreadable, encoder(30));
    expect(built.inlinedImages).toEqual(["b"]);
    expect(built.unsupportedNodes.map((node) => [node.asset, node.reason])).toEqual([
      ["a", "assetNotInlined"],
    ]);
  });

  test("a page that draws no image is built once, without asking for bytes", async () => {
    const assets = source([]);
    const spec = { id: "t", root: { type: "text", text: "hi" } };
    const built = await buildPrototypeWebPageWithImages(page([spec]), assets, encoder(1));
    expect(built.html).toBe(buildPrototypeWebPage(page([spec])).html);
    expect(assets.reads).toEqual([]);
  });
});
