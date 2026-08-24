import { describe, expect, test } from "bun:test";
import { SharpBackend } from "../../../../src/utils/image/backend/SharpBackend";
import type { ImagePipeline } from "../../../../src/utils/image/backend/ImageBackend";
import type { SharpFactory } from "../../../../src/utils/image/loadSharp";

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

interface FakeSharpImage {
  resize(options: unknown): FakeSharpImage;
  extract(options: unknown): FakeSharpImage;
  png(): FakeSharpImage;
  webp(options?: unknown): FakeSharpImage;
  toBuffer(): Promise<Buffer>;
}

function makeRecordingSharpFactory(events: string[]): SharpFactory {
  const image: FakeSharpImage = {
    resize(options) {
      events.push(`resize:${JSON.stringify(options)}`);
      return image;
    },
    extract(options) {
      events.push(`extract:${JSON.stringify(options)}`);
      return image;
    },
    png() {
      events.push("png");
      return image;
    },
    webp(options) {
      events.push(`webp:${JSON.stringify(options)}`);
      return image;
    },
    async toBuffer() {
      events.push("toBuffer");
      return Buffer.from("encoded");
    },
  };

  return ((source: Buffer) => {
    events.push(`sharp:${source.toString("utf8")}`);
    return image;
  }) as unknown as SharpFactory;
}

// Production keeps Windows on Jimp because sharp can abort under Bun there.
// These cases intentionally exercise the real native sharp backend on macOS/Linux only.
const describeSharp = process.platform === "win32" ? describe.skip : describe;

describe("SharpBackend", () => {
  describe("execute", () => {
    test("chains multi-operation pipelines without intermediate materialization", async () => {
      const events: string[] = [];
      const backend = new SharpBackend({
        loadSharp: async () => makeRecordingSharpFactory(events),
      });

      await backend.execute(Buffer.from("source"), {
        operations: [
          { type: "resize", width: 5, height: 5, maintainAspectRatio: false },
          { type: "crop", x: 1, y: 2, width: 3, height: 4 },
        ],
        encoding: { mime: "image/png" },
      });

      expect(events).toEqual([
        "sharp:source",
        'resize:{"width":5,"height":5,"fit":"fill"}',
        'extract:{"left":1,"top":2,"width":3,"height":4}',
        "png",
        "toBuffer",
      ]);
    });

    test("materializes before a second crop after resize for sharp compatibility", async () => {
      const events: string[] = [];
      const backend = new SharpBackend({
        loadSharp: async () => makeRecordingSharpFactory(events),
      });

      await backend.execute(Buffer.from("source"), {
        operations: [
          { type: "resize", width: 6, height: 6, maintainAspectRatio: false },
          { type: "crop", x: 1, y: 1, width: 4, height: 4 },
          { type: "crop", x: 1, y: 1, width: 2, height: 2 },
        ],
        encoding: { mime: "image/png" },
      });

      expect(events).toEqual([
        "sharp:source",
        'resize:{"width":6,"height":6,"fit":"fill"}',
        'extract:{"left":1,"top":1,"width":4,"height":4}',
        "toBuffer",
        "sharp:encoded",
        'extract:{"left":1,"top":1,"width":2,"height":2}',
        "png",
        "toBuffer",
      ]);
    });

    test("materializes before a second crop before resize for sharp compatibility", async () => {
      const events: string[] = [];
      const backend = new SharpBackend({
        loadSharp: async () => makeRecordingSharpFactory(events),
      });

      await backend.execute(Buffer.from("source"), {
        operations: [
          { type: "crop", x: 1, y: 1, width: 6, height: 6 },
          { type: "crop", x: 1, y: 1, width: 4, height: 4 },
          { type: "resize", width: 2, height: 2, maintainAspectRatio: false },
        ],
        encoding: { mime: "image/png" },
      });

      expect(events).toEqual([
        "sharp:source",
        'extract:{"left":1,"top":1,"width":6,"height":6}',
        "toBuffer",
        "sharp:encoded",
        'extract:{"left":1,"top":1,"width":4,"height":4}',
        'resize:{"width":2,"height":2,"fit":"fill"}',
        "png",
        "toBuffer",
      ]);
    });
  });
});

describeSharp("SharpBackend native", () => {
  describe("execute", () => {
    test("resize with fill produces exact target dimensions", async () => {
      const backend = new SharpBackend();
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
      const backend = new SharpBackend();
      const source = await makeSourcePng(8, 4);
      const meta = await backend.metadata(
        await backend.execute(source, {
          operations: [{ type: "resize", width: 6, height: 6, maintainAspectRatio: true }],
          encoding: { mime: "image/png" },
        }),
      );

      expect(meta.width).toBe(6);
      expect(meta.height).toBe(6);
    });

    test("width-only resize preserves aspect ratio", async () => {
      const backend = new SharpBackend();
      const source = await makeSourcePng(8, 4);
      const meta = await backend.metadata(
        await backend.execute(source, {
          operations: [{ type: "resize", width: 4, maintainAspectRatio: true }],
          encoding: { mime: "image/png" },
        }),
      );

      expect(meta.width).toBe(4);
      expect(meta.height).toBe(2);
    });

    test("applies crop after resize on the resized coordinate space", async () => {
      const backend = new SharpBackend();
      const source = await makeSourcePng(8, 8);
      const sharp = (await import("sharp")).default;
      const expected = await backend.rawPixels(
        await sharp(source)
          .resize({ width: 4, height: 4, fit: "fill" })
          .extract({ left: 1, top: 1, width: 2, height: 2 })
          .png()
          .toBuffer(),
      );

      const actual = await backend.rawPixels(
        await backend.execute(source, {
          operations: [
            { type: "resize", width: 4, height: 4, maintainAspectRatio: false },
            { type: "crop", x: 1, y: 1, width: 2, height: 2 },
          ],
          encoding: { mime: "image/png" },
        }),
      );

      expect(actual.width).toBe(2);
      expect(actual.height).toBe(2);
      expect(actual.data).toEqual(expected.data);
    });

    test("preserves repeated crop semantics after resize", async () => {
      const backend = new SharpBackend();
      const source = await makeSourcePng(8, 8);
      const sharp = (await import("sharp")).default;
      const firstResize = await sharp(source)
        .resize({ width: 6, height: 6, fit: "fill" })
        .toBuffer();
      const firstCrop = await sharp(firstResize)
        .extract({ left: 1, top: 1, width: 4, height: 4 })
        .toBuffer();
      const expected = await backend.rawPixels(
        await sharp(firstCrop).extract({ left: 1, top: 1, width: 2, height: 2 }).png().toBuffer(),
      );

      const actual = await backend.rawPixels(
        await backend.execute(source, {
          operations: [
            { type: "resize", width: 6, height: 6, maintainAspectRatio: false },
            { type: "crop", x: 1, y: 1, width: 4, height: 4 },
            { type: "crop", x: 1, y: 1, width: 2, height: 2 },
          ],
          encoding: { mime: "image/png" },
        }),
      );

      expect(actual.width).toBe(2);
      expect(actual.height).toBe(2);
      expect(actual.data).toEqual(expected.data);
    });

    test("preserves repeated crop semantics before resize", async () => {
      const backend = new SharpBackend();
      const source = await makeSourcePng(8, 8);
      const sharp = (await import("sharp")).default;
      const firstCrop = await sharp(source)
        .extract({ left: 1, top: 1, width: 6, height: 6 })
        .toBuffer();
      const secondCrop = await sharp(firstCrop)
        .extract({ left: 1, top: 1, width: 4, height: 4 })
        .toBuffer();
      const expected = await backend.rawPixels(
        await sharp(secondCrop).resize({ width: 2, height: 2, fit: "fill" }).png().toBuffer(),
      );

      const actual = await backend.rawPixels(
        await backend.execute(source, {
          operations: [
            { type: "crop", x: 1, y: 1, width: 6, height: 6 },
            { type: "crop", x: 1, y: 1, width: 4, height: 4 },
            { type: "resize", width: 2, height: 2, maintainAspectRatio: false },
          ],
          encoding: { mime: "image/png" },
        }),
      );

      expect(actual.width).toBe(2);
      expect(actual.height).toBe(2);
      expect(actual.data).toEqual(expected.data);
    });

    test("applies chained resize operations in pipeline order", async () => {
      const backend = new SharpBackend();
      const source = await makeSourcePng(8, 8);
      const sharp = (await import("sharp")).default;
      const firstResize = await sharp(source)
        .resize({ width: 5, height: 5, fit: "fill" })
        .toBuffer();
      const expected = await backend.rawPixels(
        await sharp(firstResize).resize({ width: 3, height: 7, fit: "fill" }).png().toBuffer(),
      );

      const actual = await backend.rawPixels(
        await backend.execute(source, {
          operations: [
            { type: "resize", width: 5, height: 5, maintainAspectRatio: false },
            { type: "resize", width: 3, height: 7, maintainAspectRatio: false },
          ],
          encoding: { mime: "image/png" },
        }),
      );

      expect(actual.width).toBe(3);
      expect(actual.height).toBe(7);
      expect(actual.data).toEqual(expected.data);
    });

    test("crop produces the requested region at the requested offset", async () => {
      const backend = new SharpBackend();
      const source = await makeSourcePng(8, 8);

      const raw = await backend.rawPixels(
        await backend.execute(source, {
          operations: [{ type: "crop", x: 1, y: 1, width: 3, height: 2 }],
          encoding: { mime: "image/png" },
        }),
      );

      expect(raw.width).toBe(3);
      expect(raw.height).toBe(2);
      expect([raw.data[0], raw.data[1], raw.data[2], raw.data[3]]).toEqual([16, 16, 1, 255]);
    });

    test("webp encodes all supported WebP option modes", async () => {
      const backend = new SharpBackend();
      const source = await makeSourcePng();

      for (const options of [
        { quality: 60 },
        { lossless: true, quality: 75 },
        { nearLossless: true, quality: 40 },
      ]) {
        const out = await backend.execute(source, {
          operations: [],
          encoding: { mime: "image/webp", options },
        });
        expect(out.subarray(0, 4).toString()).toBe("RIFF");
        expect(out.subarray(8, 12).toString()).toBe("WEBP");
      }
    });
  });

  describe("metadata", () => {
    test("reports dimensions, format, and source byte size", async () => {
      const backend = new SharpBackend();
      const source = await makeSourcePng(8, 4);

      const meta = await backend.metadata(source);

      expect(meta.width).toBe(8);
      expect(meta.height).toBe(4);
      expect(meta.format).toBe("png");
      expect(meta.size).toBe(source.length);
    });
  });

  describe("rawPixels", () => {
    test("returns RGBA data sized width*height*4", async () => {
      const backend = new SharpBackend();
      const source = await makeSourcePng(8, 4);

      const raw = await backend.rawPixels(source);

      expect(raw.width).toBe(8);
      expect(raw.height).toBe(4);
      expect(raw.data.length).toBe(8 * 4 * 4);
    });
  });
});
