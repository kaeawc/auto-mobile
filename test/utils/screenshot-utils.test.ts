import { expect, describe, test, beforeEach } from "bun:test";
import { ScreenshotUtils } from "../../src/utils/screenshot/ScreenshotUtils";
import { Jimp, rgbaToInt } from "jimp";

async function createTestImage(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  const image = new Jimp({ width, height, color: rgbaToInt(color.r, color.g, color.b, 255) });
  return image.getBuffer("image/png");
}

async function compareOk(a: Buffer, b: Buffer) {
  const result = await ScreenshotUtils.compareImages(a, b);
  if (!result.compared) {
    throw new Error(`comparison unexpectedly failed: ${result.error}`);
  }
  return result;
}

describe("ScreenshotUtils", function () {
  describe("Image Dimensions", function () {
    test("should get image dimensions correctly", async function () {
      const testImage = await createTestImage(200, 150, { r: 0, g: 255, b: 0 });

      const dimensions = await ScreenshotUtils.getImageDimensions(testImage);
      expect(dimensions.width).toBe(200);
      expect(dimensions.height).toBe(150);
    });
  });

  describe("Image Comparison", function () {
    let identicalImage1: Buffer;
    let identicalImage2: Buffer;
    let differentImage: Buffer;

    beforeEach(async function () {
      // Create identical images
      identicalImage1 = await createTestImage(100, 100, { r: 255, g: 255, b: 255 });

      identicalImage2 = await createTestImage(100, 100, { r: 255, g: 255, b: 255 });

      // Create different image
      differentImage = await createTestImage(100, 100, { r: 0, g: 0, b: 0 });
    });

    test("should detect identical images with 100% similarity", async function () {
      const result = await compareOk(identicalImage1, identicalImage2);

      expect(result.similarity).toBe(100);
      expect(result.pixelDifference).toBe(0);
      expect(result.totalPixels).toBe(10000); // 100x100
    });

    test("should detect completely different images with low similarity", async function () {
      const result = await compareOk(identicalImage1, differentImage);

      expect(result.similarity).toBeLessThan(50);
      expect(result.pixelDifference).toBeGreaterThan(0);
      expect(result.totalPixels).toBe(10000);
    });

    test("should handle comparison of different sized images", async function () {
      const largeImage = await createTestImage(200, 200, { r: 255, g: 255, b: 255 });

      const result = await compareOk(identicalImage1, largeImage);

      expect(result.similarity).toBe(100);
      expect(result.totalPixels).toBe(10000); // Should use smaller dimensions
    });

    test("should handle invalid images gracefully", async function () {
      const invalidBuffer = Buffer.from("not an image");

      const result = await ScreenshotUtils.compareImages(identicalImage1, invalidBuffer);

      // A failed comparison is distinguishable from "completely different" (#10185).
      expect(result.compared).toBe(false);
      expect(result).not.toHaveProperty("similarity");
    });
  });

  describe("Error Handling", function () {
    test("should handle dimension errors gracefully", async function () {
      const invalidBuffer = Buffer.from("not an image");

      try {
        await ScreenshotUtils.getImageDimensions(invalidBuffer);
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain("Failed to get image dimensions");
      }
    });
  });
});
