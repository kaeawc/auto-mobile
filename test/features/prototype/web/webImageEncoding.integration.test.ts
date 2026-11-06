import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSharp } from "../../../../src/utils/image/loadSharp";
import {
  buildPrototypeWebPageWithImages,
  SharpPrototypeWebImageEncoder,
  type PrototypeWebAssetSource,
} from "../../../../src/features/prototype/web/webImageEncoding";
import { MAX_PROTOTYPE_WEB_PAGE_BYTES } from "../../../../src/features/prototype/web/webPage";

// Real sharp encodes (#16533): the per-test 100 ms unit budget does not cover a native image backend.

const ANDROID = { applyExifOrientation: false };

/** A deterministic 2000x1500 "photo": smooth colour gradients with pseudo-random grain. */
async function photo(seed: number): Promise<Uint8Array> {
  const width = 2000;
  const height = 1500;
  const raw = Buffer.alloc(width * height * 3);
  let state = seed * 2654435761;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = (state * 1103515245 + 12345) >>> 0;
      const grain = (state >>> 24) % 24;
      const at = (y * width + x) * 3;
      raw[at] = (x / 8 + seed * 40 + grain) % 256;
      raw[at + 1] = (y / 6 + grain) % 256;
      raw[at + 2] = ((x + y) / 14 + seed * 25) % 256;
    }
  }
  const sharp = await loadSharp();
  return new Uint8Array(
    await sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer(),
  );
}

describe("prototype web page images with sharp", () => {
  test("a feed of 10 photo assets inlines every one in a page under 2 MiB", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `photo-${index}`);
    const photos = new Map(
      await Promise.all(ids.map(async (id, index) => [id, await photo(index + 1)] as const)),
    );
    const source: PrototypeWebAssetSource = {
      get: async (id) => {
        const bytes = photos.get(id);
        return bytes ? { mimeType: "image/jpeg", bytes } : undefined;
      },
    };
    const spec = {
      id: "feed",
      window: { placement: { type: "fullscreen" } },
      root: {
        type: "scroll",
        style: { width: "fill", height: "fill" },
        child: {
          type: "column",
          repeat: { as: "post", items: ids.map((id) => ({ photo: id })) },
          children: [
            {
              type: "image",
              asset: "{post.photo}",
              contentScale: "crop",
              style: { width: "fill", height: { dp: 240 }, cornerRadius: 12 },
            },
          ],
        },
      },
    };
    const page = await buildPrototypeWebPageWithImages(
      {
        title: "Feed",
        frame: "pixel-9",
        variants: [
          { id: "feed", label: "Feed", revisions: [{ revision: 1, operation: "show", spec }] },
        ],
      },
      source,
      new SharpPrototypeWebImageEncoder(),
    );
    expect(page.inlinedImages).toEqual(ids);
    expect(page.unsupportedNodes).toEqual([]);
    expect(Buffer.byteLength(page.html)).toBeLessThan(MAX_PROTOTYPE_WEB_PAGE_BYTES);
  }, 30_000);

  test("re-encodes a fixture asset as WebP at the largest size drawn, never enlarged", async () => {
    const png = new Uint8Array(
      readFileSync(join(import.meta.dir, "../../../fixtures/prototype-web/assets/sunset.png")),
    );
    const encoder = new SharpPrototypeWebImageEncoder();
    const half = await encoder.encode(png, [{ width: 120, height: 120, cover: false }], ANDROID);
    expect(Buffer.from(half.bytes.subarray(8, 12)).toString("ascii")).toBe("WEBP");
    expect([half.width, half.height]).toEqual([120, 80]);
    const whole = await encoder.encode(png, [{ height: 525, cover: true }], ANDROID);
    expect([whole.width, whole.height]).toEqual([240, 160]);
  });

  test("applies EXIF orientation for iOS and leaves it for Android, as each device draws (#17241)", async () => {
    // A 40x20 JPEG tagged orientation 6 (rotate 90 clockwise): iOS's UIImage(data:) draws it 20x40,
    // Android's BitmapFactory ignores the tag and draws the stored 40x20 pixels.
    const sharp = await loadSharp();
    const jpeg = new Uint8Array(
      await sharp({ create: { width: 40, height: 20, channels: 3, background: "#f00" } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );
    const encoder = new SharpPrototypeWebImageEncoder();
    // A box half the oriented height: the scale must come from the oriented size.
    const box = [{ width: 100, height: 20, cover: false }];
    const ios = await encoder.encode(jpeg, box, { applyExifOrientation: true });
    expect([ios.width, ios.height]).toEqual([10, 20]);
    expect((await sharp(Buffer.from(ios.bytes)).metadata()).orientation).toBeUndefined();
    const android = await encoder.encode(jpeg, box, ANDROID);
    expect([android.width, android.height]).toEqual([40, 20]);
  });
});
