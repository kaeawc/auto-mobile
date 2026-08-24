import { describe, expect, test } from "bun:test";
import { ScreenshotComparator } from "../../../src/utils/screenshot/ScreenshotComparator";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";

// A minimal valid-looking PNG header + IHDR width/height so the IHDR fast path
// and isPngBuffer() are exercised without a real encoder.
function pngWithDimensions(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("ScreenshotComparator backend routing", () => {
  describe("getImageDimensions", () => {
    test("PNG IHDR fast path avoids a backend decode", async () => {
      const backend = new FakeImageBackend();
      const png = pngWithDimensions(320, 640);

      const dims = await ScreenshotComparator.getImageDimensions(png, backend);

      expect(dims).toEqual({ width: 320, height: 640 });
      // Fast path must not call the backend at all (no full decode).
      expect(backend.metadataCalls).toHaveLength(0);
    });

    test("non-PNG buffer falls through to backend.metadata", async () => {
      const backend = new FakeImageBackend();
      backend.setMetadataResult({ width: 111, height: 222, format: "webp", size: 10 });
      const notPng = Buffer.from("RIFF....WEBP");

      const dims = await ScreenshotComparator.getImageDimensions(notPng, backend);

      expect(dims).toEqual({ width: 111, height: 222 });
      expect(backend.metadataCalls).toHaveLength(1);
    });

    test("wraps backend decode failures with a stable message", async () => {
      const backend = new FakeImageBackend();
      backend.setShouldThrowOnMetadata(true);

      await expect(
        ScreenshotComparator.getImageDimensions(Buffer.from("nope"), backend),
      ).rejects.toThrow("Failed to get image dimensions");
    });
  });

  describe("convertToPng", () => {
    test("routes through backend.execute with a png encoding and no operations", async () => {
      const backend = new FakeImageBackend();
      backend.setExecuteResult(Buffer.from("png-bytes"));

      const out = await ScreenshotComparator.convertToPng(Buffer.from("src"), backend);

      expect(out.toString()).toBe("png-bytes");
      expect(backend.executeCalls).toHaveLength(1);
      expect(backend.lastPipeline).toEqual({ operations: [], encoding: { mime: "image/png" } });
    });

    test("wraps backend failures with a stable message", async () => {
      const backend = new FakeImageBackend();
      backend.setShouldThrowOnExecute(true);

      await expect(ScreenshotComparator.convertToPng(Buffer.from("bad"), backend)).rejects.toThrow(
        "Failed to convert image to PNG",
      );
    });
  });

  describe("resizeImageIfNeeded", () => {
    test("resizes via backend.execute using a nearest-mode resize + png encoding", async () => {
      const backend = new FakeImageBackend();
      backend.setExecuteResult(Buffer.from("resized"));
      // Source is 320x640 (IHDR), target differs so a resize is required.
      const png = pngWithDimensions(320, 640);

      const out = await ScreenshotComparator.resizeImageIfNeeded(png, 160, 320, backend);

      expect(out.toString()).toBe("resized");
      expect(backend.lastPipeline).toEqual({
        operations: [
          { type: "resize", width: 160, height: 320, maintainAspectRatio: false, mode: "nearest" },
        ],
        encoding: { mime: "image/png" },
      });
    });

    test("returns the original buffer untouched when already at the target size", async () => {
      const backend = new FakeImageBackend();
      const png = pngWithDimensions(200, 200);

      const out = await ScreenshotComparator.resizeImageIfNeeded(png, 200, 200, backend);

      expect(out).toBe(png);
      expect(backend.executeCalls).toHaveLength(0);
    });
  });
});
