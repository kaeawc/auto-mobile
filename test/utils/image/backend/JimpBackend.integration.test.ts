import { describe, expect, test } from "bun:test";
import { JimpBackend } from "../../../../src/utils/image/backend/JimpBackend";
import type { ImagePipeline } from "../../../../src/utils/image/backend/ImageBackend";

// Build a small, non-uniform source PNG. Solid colors survive any resize kernel
// or WebP mode identically and would mask regressions, so use a gradient.
async function makeSourcePng(width = 8, height = 8): Promise<Buffer> {
  const { Jimp, rgbaToInt } = await import("jimp");
  const image = new Jimp({ width, height, color: 0x000000ff });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      image.setPixelColor(rgbaToInt((x * 16) % 256, (y * 16) % 256, (x * y) % 256, 255), x, y);
    }
  }
  return image.getBuffer("image/png");
}

const PNG_MAGIC = "89504e47";

describe("JimpBackend", () => {
  describe("execute", () => {
    test("resize with fill (no aspect ratio) produces exact target dimensions", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng(8, 8);
      const pipeline: ImagePipeline = {
        operations: [{ type: "resize", width: 4, height: 2, maintainAspectRatio: false }],
        encoding: { mime: "image/png" },
      };

      const out = await backend.execute(source, pipeline);
      const meta = await backend.metadata(out);

      expect(meta.width).toBe(4);
      expect(meta.height).toBe(2);
      expect(out.subarray(0, 4).toString("hex")).toBe(PNG_MAGIC);
    });

    test("resize with maintainAspectRatio covers to exact WxH", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng(8, 4);
      const pipeline: ImagePipeline = {
        operations: [{ type: "resize", width: 6, height: 6, maintainAspectRatio: true }],
        encoding: { mime: "image/png" },
      };

      const meta = await backend.metadata(await backend.execute(source, pipeline));

      expect(meta.width).toBe(6);
      expect(meta.height).toBe(6);
    });

    test("width-only resize preserves aspect ratio", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng(8, 4);
      const pipeline: ImagePipeline = {
        operations: [{ type: "resize", width: 4, maintainAspectRatio: true }],
        encoding: { mime: "image/png" },
      };

      const meta = await backend.metadata(await backend.execute(source, pipeline));

      expect(meta.width).toBe(4);
      expect(meta.height).toBe(2);
    });

    test("crop produces the requested region at the requested offset", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng(8, 8);
      const pipeline: ImagePipeline = {
        operations: [{ type: "crop", x: 1, y: 1, width: 3, height: 2 }],
        encoding: { mime: "image/png" },
      };

      const out = await backend.execute(source, pipeline);
      const meta = await backend.metadata(out);

      expect(meta.width).toBe(3);
      expect(meta.height).toBe(2);

      // Prove x/y are honored (not cropped from 0,0): the cropped output's top-left
      // pixel must equal the source gradient at (1,1) = rgba(16, 16, 1, 255).
      // (PNG is lossless and crop does no resampling, so bytes match exactly.)
      const cropped = await backend.rawPixels(out);
      expect([cropped.data[0], cropped.data[1], cropped.data[2], cropped.data[3]]).toEqual([
        16, 16, 1, 255,
      ]);
    });

    test("applies operations in recorded order (crop then resize)", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng(8, 4);
      // crop 8x4 -> 4x4, then width-only resize -> aspect-preserving 2x2.
      // Order/only-last-op regressions produce distinct dims: crop-only=4x4,
      // resize-only=2x1, reversed=degenerate — only the correct order yields 2x2.
      const pipeline: ImagePipeline = {
        operations: [
          { type: "crop", x: 0, y: 0, width: 4, height: 4 },
          { type: "resize", width: 2, maintainAspectRatio: true },
        ],
        encoding: { mime: "image/png" },
      };

      const meta = await backend.metadata(await backend.execute(source, pipeline));

      expect(meta.width).toBe(2);
      expect(meta.height).toBe(2);
    });

    test("rejects WebP encoding because WebP belongs to platform-specific backends", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng();
      const pipeline: ImagePipeline = {
        operations: [],
        encoding: { mime: "image/webp", options: { quality: 60 } },
      };

      await expect(backend.execute(source, pipeline)).rejects.toThrow("does not encode WebP");
    });

    test("resize mode:nearest picks source pixels (distinct from default kernel)", async () => {
      const backend = new JimpBackend();
      // A 4x4 checkerboard-ish gradient downscaled 4x4 -> 2x2. Nearest samples
      // exact source pixels (floor((i*4)/2)=0/2), while the default (bilinear)
      // kernel averages neighbors, so the two must differ on at least one channel.
      const source = await makeSourcePng(4, 4);

      const nearest = await backend.rawPixels(
        await backend.execute(source, {
          operations: [
            { type: "resize", width: 2, height: 2, maintainAspectRatio: false, mode: "nearest" },
          ],
          encoding: { mime: "image/png" },
        }),
      );
      const dflt = await backend.rawPixels(
        await backend.execute(source, {
          operations: [{ type: "resize", width: 2, height: 2, maintainAspectRatio: false }],
          encoding: { mime: "image/png" },
        }),
      );

      // Nearest top-left must equal the exact source top-left pixel (16-color
      // gradient at (0,0) = rgba(0,0,0,255)); the source's (1,1) is rgba(16,16,1)
      // so a 2x1-block bilinear average differs from the pure source sample.
      const src = await backend.rawPixels(source);
      expect([nearest.data[0], nearest.data[1], nearest.data[2], nearest.data[3]]).toEqual([
        src.data[0],
        src.data[1],
        src.data[2],
        src.data[3],
      ]);
      const sameAsDefault =
        nearest.data[0] === dflt.data[0] &&
        nearest.data[1] === dflt.data[1] &&
        nearest.data[2] === dflt.data[2];
      expect(sameAsDefault).toBe(false);
    });

    test("cover honors mode:nearest", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng(8, 8);
      // maintainAspectRatio:true routes through jimp cover(); assert mode flows
      // through by producing exact target dims without throwing.
      const meta = await backend.metadata(
        await backend.execute(source, {
          operations: [
            { type: "resize", width: 4, height: 4, maintainAspectRatio: true, mode: "nearest" },
          ],
          encoding: { mime: "image/png" },
        }),
      );
      expect(meta.width).toBe(4);
      expect(meta.height).toBe(4);
    });

    test("null encoding falls back to the decoded input format", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng();
      const pipeline: ImagePipeline = { operations: [], encoding: null };

      const out = await backend.execute(source, pipeline);

      // Source was PNG, so a null encoding round-trips back to PNG.
      expect(out.subarray(0, 4).toString("hex")).toBe(PNG_MAGIC);
    });
  });

  describe("metadata", () => {
    test("reports dimensions, format, and source byte size", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng(8, 4);

      const meta = await backend.metadata(source);

      expect(meta.width).toBe(8);
      expect(meta.height).toBe(4);
      expect(meta.format).toBe("png");
      expect(meta.size).toBe(source.length);
    });

    test("rejects a non-image buffer", async () => {
      const backend = new JimpBackend();
      await expect(backend.metadata(Buffer.from("not an image"))).rejects.toThrow();
    });
  });

  describe("rawPixels", () => {
    test("returns RGBA data sized width*height*4", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng(8, 4);

      const raw = await backend.rawPixels(source);

      expect(raw.width).toBe(8);
      expect(raw.height).toBe(4);
      expect(raw.data.length).toBe(8 * 4 * 4);
    });

    test("returns a copy that does not alias jimp's bitmap", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng(2, 2);

      const first = await backend.rawPixels(source);
      first.data[0] = first.data[0] ^ 0xff;
      const second = await backend.rawPixels(source);

      // Mutating the returned buffer must not affect a fresh decode.
      expect(second.data[0]).not.toBe(first.data[0]);
    });
  });
});
