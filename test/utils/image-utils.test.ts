import { expect, describe, test, beforeEach } from "bun:test";
import { JimpImageUtils } from "../../src/utils/image-utils";
import { FakeImageUtils } from "../fakes/FakeImageUtils";

describe("ImageUtils", () => {
  let imageUtils: JimpImageUtils;

  beforeEach(() => {
    imageUtils = new JimpImageUtils();
  });

  describe("getOriginalBuffer", () => {
    test("should return a copy of the buffer", () => {
      const originalBuffer = Buffer.from("test data");
      const result = imageUtils.getOriginalBuffer(originalBuffer);

      expect(result).toEqual(originalBuffer);
      expect(result).not.toBe(originalBuffer); // Should be a copy
    });
  });

  describe("cache management", () => {
    test("should clear cache", () => {
      expect(() => {
        imageUtils.clearCache();
      }).not.toThrow();
    });

    test("should set cache size", () => {
      expect(() => {
        imageUtils.setCacheSize(100);
      }).not.toThrow();
    });
  });

  describe("batchProcess", () => {
    test("should process multiple buffers", async () => {
      const buffers = [Buffer.from("data1"), Buffer.from("data2")];
      const results = await imageUtils.batchProcess(buffers, async (buffer) => {
        return Buffer.from(buffer.toString() + "_processed");
      });

      expect(results).toHaveLength(2);
      expect(results[0].toString()).toBe("data1_processed");
      expect(results[1].toString()).toBe("data2_processed");
    });
  });
});

describe("FakeImageUtils", () => {
  let fakeImageUtils: FakeImageUtils;

  beforeEach(() => {
    fakeImageUtils = new FakeImageUtils();
  });

  describe("configuration and defaults", () => {
    test("should return default metadata", async () => {
      const metadata = await fakeImageUtils.getMetadata(Buffer.from("test"));

      expect(metadata.width).toBe(1080);
      expect(metadata.height).toBe(2400);
      expect(metadata.format).toBe("png");
    });

    test("Fake metadata stays in parity with the real jimp shape", async () => {
      // Guards the Fake's defaults, not the real path (which is type-constrained
      // to width/height/format/size). The real getMetadata only yields those
      // four fields, so the Fake must not be more capable than production (#2938).
      const metadata = await fakeImageUtils.getMetadata(Buffer.from("test"));

      expect(metadata).not.toHaveProperty("colorSpace");
      expect(metadata).not.toHaveProperty("hasAlpha");
      expect(metadata).not.toHaveProperty("exif");
    });

    test("should allow configuring metadata", async () => {
      const customMetadata = {
        width: 800,
        height: 600,
        format: "jpg",
        size: 500000,
      };
      fakeImageUtils.setMetadataResult(customMetadata);
      const metadata = await fakeImageUtils.getMetadata(Buffer.from("test"));

      expect(metadata.width).toBe(800);
      expect(metadata.height).toBe(600);
      expect(metadata.format).toBe("jpg");
    });

    test("should return PNG magic bytes by default for toPng", async () => {
      const result = await fakeImageUtils.toPng(Buffer.from("test"));

      expect(result.slice(0, 4).toString("hex")).toBe("89504e47");
    });

    test("should allow configuring PNG result", async () => {
      const customBuffer = Buffer.from([1, 2, 3, 4]);
      fakeImageUtils.setPngResult(customBuffer);
      const result = await fakeImageUtils.toPng(Buffer.from("test"));

      expect(result).toEqual(customBuffer);
    });
  });

  describe("call tracking", () => {
    test("should track method calls", async () => {
      await fakeImageUtils.resize(Buffer.from("test"), 100, 200);

      expect(fakeImageUtils.wasMethodCalled("resize")).toBe(true);
      expect(fakeImageUtils.getMethodCallCount("resize")).toBe(1);
    });

    test("should track multiple calls", async () => {
      await fakeImageUtils.resize(Buffer.from("test"), 100);
      await fakeImageUtils.resize(Buffer.from("test"), 200);

      expect(fakeImageUtils.getMethodCallCount("resize")).toBe(2);
    });

    test("should track call parameters", async () => {
      const buffer = Buffer.from("test data");
      await fakeImageUtils.resize(buffer, 100, 200, false);

      const calls = fakeImageUtils.getMethodCalls("resize");
      expect(calls[0].width).toBe(100);
      expect(calls[0].height).toBe(200);
      expect(calls[0].maintainAspectRatio).toBe(false);
    });

    test("should clear call history", async () => {
      await fakeImageUtils.resize(Buffer.from("test"), 100);
      fakeImageUtils.clearCallHistory();

      expect(fakeImageUtils.getMethodCallCount("resize")).toBe(0);
    });

    test("should track different method calls separately", async () => {
      await fakeImageUtils.resize(Buffer.from("test"), 100);
      await fakeImageUtils.crop(Buffer.from("test"), 50, 50);

      expect(fakeImageUtils.getMethodCallCount("resize")).toBe(1);
      expect(fakeImageUtils.getMethodCallCount("crop")).toBe(1);
    });
  });

  describe("error injection", () => {
    test("should throw on getOriginalBuffer when configured", () => {
      fakeImageUtils.setShouldThrowOnGetOriginalBuffer(true);

      expect(() => {
        fakeImageUtils.getOriginalBuffer(Buffer.from("test"));
      }).toThrow("Simulated error in getOriginalBuffer");
    });

    test("should throw on resize when configured", async () => {
      fakeImageUtils.setShouldThrowOnResize(true);

      try {
        await fakeImageUtils.resize(Buffer.from("test"), 100);
        throw new Error("Should have thrown");
      } catch (error: any) {
        expect(error.message).toBe("Simulated error in resize");
      }
    });

    test("should throw on crop when configured", async () => {
      fakeImageUtils.setShouldThrowOnCrop(true);

      try {
        await fakeImageUtils.crop(Buffer.from("test"), 100, 100);
        throw new Error("Should have thrown");
      } catch (error: any) {
        expect(error.message).toBe("Simulated error in crop");
      }
    });

    test("should throw on toPng when configured", async () => {
      fakeImageUtils.setShouldThrowOnToPng(true);

      try {
        await fakeImageUtils.toPng(Buffer.from("test"));
        throw new Error("Should have thrown");
      } catch (error: any) {
        expect(error.message).toBe("Simulated error in toPng");
      }
    });

    test("should throw on toWebp when configured", async () => {
      fakeImageUtils.setShouldThrowOnToWebp(true);

      try {
        await fakeImageUtils.toWebp(Buffer.from("test"));
        throw new Error("Should have thrown");
      } catch (error: any) {
        expect(error.message).toBe("Simulated error in toWebp");
      }
    });

    test("should throw on getMetadata when configured", async () => {
      fakeImageUtils.setShouldThrowOnGetMetadata(true);

      try {
        await fakeImageUtils.getMetadata(Buffer.from("test"));
        throw new Error("Should have thrown");
      } catch (error: any) {
        expect(error.message).toBe("Simulated error in getMetadata");
      }
    });

    test("should throw on batchProcess when configured", async () => {
      fakeImageUtils.setShouldThrowOnBatchProcess(true);

      try {
        await fakeImageUtils.batchProcess([Buffer.from("test")], async (b) => b);
        throw new Error("Should have thrown");
      } catch (error: any) {
        expect(error.message).toBe("Simulated error in batchProcess");
      }
    });
  });

  describe("complex scenarios", () => {
    test("should track all method calls in a sequence", async () => {
      const buffer = Buffer.from("test");

      await fakeImageUtils.resize(buffer, 100);
      await fakeImageUtils.crop(buffer, 50, 50);
      await fakeImageUtils.toWebp(buffer);
      await fakeImageUtils.toPng(buffer);

      expect(fakeImageUtils.getMethodCallCount("resize")).toBe(1);
      expect(fakeImageUtils.getMethodCallCount("crop")).toBe(1);
      expect(fakeImageUtils.getMethodCallCount("toWebp")).toBe(1);
      expect(fakeImageUtils.getMethodCallCount("toPng")).toBe(1);
    });

    test("should handle batch process with custom results", async () => {
      const buffer1 = Buffer.from("result1");
      const buffer2 = Buffer.from("result2");
      fakeImageUtils.setBatchProcessResult([buffer1, buffer2]);

      const results = await fakeImageUtils.batchProcess(
        [Buffer.from("input1"), Buffer.from("input2")],
        async (b) => b,
      );

      expect(results).toEqual([buffer1, buffer2]);
      expect(fakeImageUtils.getMethodCallCount("batchProcess")).toBe(1);
    });

    test("should handle batch process with default transform", async () => {
      const results = await fakeImageUtils.batchProcess(
        [Buffer.from("test1"), Buffer.from("test2")],
        async (b) => Buffer.from(b.toString() + "_processed"),
      );

      expect(results).toHaveLength(2);
      expect(results[0].toString()).toBe("test1_processed");
      expect(results[1].toString()).toBe("test2_processed");
    });
  });
});
