import { describe, expect, test, beforeEach } from "bun:test";
import { Image } from "../../../src/utils/image/ImageTransformer";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("ImageTransformer (declarative pipeline + backend delegation)", () => {
  let backend: FakeImageBackend;
  let timer: FakeTimer;
  const source = Buffer.from("source-image-bytes");

  const imageOf = (buffer: Buffer = source) => Image.fromBuffer(buffer, timer, backend);

  beforeEach(() => {
    backend = new FakeImageBackend();
    timer = new FakeTimer();
    Image.clearCache();
  });

  describe("pipeline recording", () => {
    test("resize records a resize operation and no encoding", async () => {
      await imageOf().resize(100, 200, false).disableCache().toBuffer();

      const pipeline = backend.lastPipeline!;
      expect(pipeline.operations).toEqual([
        { type: "resize", width: 100, height: 200, maintainAspectRatio: false },
      ]);
      expect(pipeline.encoding).toBeNull();
    });

    test("width-only resize records height as undefined and default aspect ratio", async () => {
      await imageOf().resize(100).disableCache().toBuffer();

      expect(backend.lastPipeline!.operations).toEqual([
        { type: "resize", width: 100, height: undefined, maintainAspectRatio: true },
      ]);
    });

    test("crop records a crop operation with defaults for x/y", async () => {
      await imageOf().crop(50, 40).disableCache().toBuffer();

      expect(backend.lastPipeline!.operations).toEqual([
        { type: "crop", x: 0, y: 0, width: 50, height: 40 },
      ]);
    });

    test("chained operations record in call order", async () => {
      await imageOf().crop(50, 40, 5, 6).resize(20, 20, false).png().disableCache().toBuffer();

      const pipeline = backend.lastPipeline!;
      expect(pipeline.operations).toEqual([
        { type: "crop", x: 5, y: 6, width: 50, height: 40 },
        { type: "resize", width: 20, height: 20, maintainAspectRatio: false },
      ]);
      expect(pipeline.encoding).toEqual({ mime: "image/png" });
    });

    test("png records png encoding", async () => {
      await imageOf().png().disableCache().toBuffer();
      expect(backend.lastPipeline!.encoding).toEqual({ mime: "image/png" });
    });

    test("webp default records quality 75", async () => {
      await imageOf().webp().disableCache().toBuffer();
      expect(backend.lastPipeline!.encoding).toEqual({
        mime: "image/webp",
        options: { quality: 75 },
      });
    });

    test("webp lossless records backend-neutral lossless intent", async () => {
      await imageOf().webp({ lossless: true, quality: 90 }).disableCache().toBuffer();
      expect(backend.lastPipeline!.encoding).toEqual({
        mime: "image/webp",
        options: { lossless: true, quality: 90 },
      });
    });

    test("webp nearLossless records backend-neutral nearLossless intent", async () => {
      await imageOf().webp({ nearLossless: true, quality: 40 }).disableCache().toBuffer();
      expect(backend.lastPipeline!.encoding).toEqual({
        mime: "image/webp",
        options: { nearLossless: true, quality: 40 },
      });
    });
  });

  describe("delegation", () => {
    test("toBuffer returns the backend result", async () => {
      backend.setExecuteResult(Buffer.from("encoded-output"));
      const result = await imageOf().png().disableCache().toBuffer();
      expect(result.toString()).toBe("encoded-output");
    });

    test("toBuffer passes the original source buffer to the backend", async () => {
      await imageOf().png().disableCache().toBuffer();
      expect(backend.executeCalls[0].source).toBe(source);
    });

    test("toBuffer wraps backend failures in an 'Image processing error' message", async () => {
      backend.setShouldThrowOnExecute(true);
      await expect(imageOf().png().disableCache().toBuffer()).rejects.toThrow(
        "Image processing error: Simulated error in execute",
      );
    });

    test("getMetadata delegates to backend.metadata", async () => {
      backend.setMetadataResult({ width: 320, height: 480, format: "webp", size: 42 });
      const meta = await imageOf().getMetadata();
      expect(meta).toEqual({ width: 320, height: 480, format: "webp", size: 42 });
      expect(backend.metadataCalls[0]).toBe(source);
    });

    test("getMetadata wraps backend failures", async () => {
      backend.setShouldThrowOnMetadata(true);
      await expect(imageOf().getMetadata()).rejects.toThrow(
        "Failed to get image metadata: Simulated error in metadata",
      );
    });
  });

  describe("validation (unchanged public contract)", () => {
    test("resize rejects non-positive width", () => {
      expect(() => imageOf().resize(0)).toThrow("Width must be a positive number");
    });

    test("resize rejects non-positive height", () => {
      expect(() => imageOf().resize(10, -1)).toThrow("Height must be a positive number");
    });

    test("crop rejects non-positive dimensions", () => {
      expect(() => imageOf().crop(0, 10)).toThrow("Crop dimensions must be positive numbers");
    });

    test("webp rejects out-of-range quality", () => {
      expect(() => imageOf().webp({ quality: 101 })).toThrow(
        "WebP quality must be between 1 and 100",
      );
      expect(() => imageOf().webp({ quality: -1 })).toThrow(
        "WebP quality must be between 1 and 100",
      );
    });

    test("webp quality 0 falls back to the default (preserved || quirk)", async () => {
      // `quality || DEFAULT_WEBP_QUALITY` treats 0 as falsy, so it becomes 75
      // rather than throwing. Preserving this pre-existing behavior verbatim.
      await imageOf().webp({ quality: 0 }).disableCache().toBuffer();
      expect(backend.lastPipeline!.encoding).toEqual({
        mime: "image/webp",
        options: { quality: 75 },
      });
    });

    test("fromBuffer rejects a non-buffer input", () => {
      expect(() => Image.fromBuffer("nope" as unknown as Buffer)).toThrow("Input must be a Buffer");
    });
  });

  describe("caching (backend-agnostic)", () => {
    test("identical pipeline hits cache and only calls the backend once", async () => {
      backend.setExecuteResult(Buffer.from("cached-output"));

      const first = await imageOf().resize(10, 10, false).png().toBuffer();
      const second = await imageOf().resize(10, 10, false).png().toBuffer();

      expect(first.toString()).toBe("cached-output");
      expect(second.toString()).toBe("cached-output");
      expect(backend.executeCalls.length).toBe(1);
    });

    test("different pipelines do not collide in the cache", async () => {
      await imageOf().resize(10, 10, false).png().toBuffer();
      await imageOf().resize(20, 20, false).png().toBuffer();
      expect(backend.executeCalls.length).toBe(2);
    });

    test("disableCache always calls the backend", async () => {
      await imageOf().png().disableCache().toBuffer();
      await imageOf().png().disableCache().toBuffer();
      expect(backend.executeCalls.length).toBe(2);
    });
  });
});
