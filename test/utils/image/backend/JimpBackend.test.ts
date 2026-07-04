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

// Executing @jimp/wasm-webp encode/decode under `bun test` on Windows can
// segfault via the JSC Wasm OSR/JIT path (bun#26366). CI keeps the invariant
// "no bun-test unit executes WebP on Windows" (WebP is covered on ubuntu by the
// image-runtime smoke), so gate the WebP-executing cases the same way. PNG
// decode/encode does not hit the WebP WASM hot path and runs on all platforms.
const skipWebpOnWindows = process.platform === "win32" ? test.skip : test;

describe("JimpBackend", () => {
  describe("execute", () => {
    test("resize with fill (no aspect ratio) produces exact target dimensions", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng(8, 8);
      const pipeline: ImagePipeline = {
        operations: [{ type: "resize", width: 4, height: 2, maintainAspectRatio: false }],
        encoding: { mime: "image/png" }
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
        encoding: { mime: "image/png" }
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
        encoding: { mime: "image/png" }
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
        encoding: { mime: "image/png" }
      };

      const out = await backend.execute(source, pipeline);
      const meta = await backend.metadata(out);

      expect(meta.width).toBe(3);
      expect(meta.height).toBe(2);

      // Prove x/y are honored (not cropped from 0,0): the cropped output's top-left
      // pixel must equal the source gradient at (1,1) = rgba(16, 16, 1, 255).
      // (PNG is lossless and crop does no resampling, so bytes match exactly.)
      const cropped = await backend.rawPixels(out);
      expect([cropped.data[0], cropped.data[1], cropped.data[2], cropped.data[3]]).toEqual([16, 16, 1, 255]);
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
          { type: "resize", width: 2, maintainAspectRatio: true }
        ],
        encoding: { mime: "image/png" }
      };

      const meta = await backend.metadata(await backend.execute(source, pipeline));

      expect(meta.width).toBe(2);
      expect(meta.height).toBe(2);
    });

    skipWebpOnWindows("webp encoding produces a RIFF/WEBP container", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng();
      const pipeline: ImagePipeline = {
        operations: [],
        encoding: { mime: "image/webp", options: { quality: 60 } }
      };

      const out = await backend.execute(source, pipeline);

      expect(out.subarray(0, 4).toString()).toBe("RIFF");
      expect(out.subarray(8, 12).toString()).toBe("WEBP");
    });

    skipWebpOnWindows("nearLossless webp is distinct from lossless (option not dropped)", async () => {
      const backend = new JimpBackend();
      const source = await makeSourcePng();

      const lossless = await backend.execute(source, {
        operations: [],
        encoding: { mime: "image/webp", options: { lossless: 1, quality: 75 } }
      });
      const nearLossless = await backend.execute(source, {
        operations: [],
        encoding: { mime: "image/webp", options: { lossless: 1, nearLossless: 40 } }
      });

      expect(nearLossless.length).not.toBe(lossless.length);
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
