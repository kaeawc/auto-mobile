import { describe, expect, test } from "bun:test";
import { PerceptualHasher } from "../../../src/utils/screenshot/PerceptualHasher";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";

// Compute the hash the way the pre-seam PerceptualHasher did — via the real jimp
// resize(8x8, NEAREST)+greyscale+red-channel pipeline — so the backend-routed
// implementation can be pinned byte-for-byte against jimp (no silent drift).
async function jimpGoldenHash(buffer: Buffer): Promise<string> {
  const { Jimp, ResizeStrategy } = await import("jimp");
  const image = await Jimp.fromBuffer(buffer);
  image.resize({ w: 8, h: 8, mode: ResizeStrategy.NEAREST_NEIGHBOR }).greyscale();
  const data = image.bitmap.data;
  let sum = 0;
  for (let i = 0; i < 64; i++) {
    sum += data[i * 4];
  }
  const avg = sum / 64;
  let hash = "";
  for (let i = 0; i < 64; i++) {
    hash += data[i * 4] > avg ? "1" : "0";
  }
  return hash;
}

async function gradientPng(width = 24, height = 24): Promise<Buffer> {
  const { Jimp, rgbaToInt } = await import("jimp");
  const image = new Jimp({ width, height, color: 0x000000ff });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      image.setPixelColor(rgbaToInt((x * 10) % 256, (y * 10) % 256, (x * y) % 256, 255), x, y);
    }
  }
  return image.getBuffer("image/png");
}

describe("PerceptualHasher", () => {
  describe("calculateHammingDistance", () => {
    test("returns 0 for identical hashes", () => {
      expect(PerceptualHasher.calculateHammingDistance("1010", "1010")).toBe(0);
    });

    test("returns correct distance for different hashes", () => {
      expect(PerceptualHasher.calculateHammingDistance("1010", "1001")).toBe(2);
    });

    test("returns max length for completely different hashes", () => {
      expect(PerceptualHasher.calculateHammingDistance("1111", "0000")).toBe(4);
    });

    test("returns max length for different length hashes", () => {
      expect(PerceptualHasher.calculateHammingDistance("111", "00000")).toBe(5);
    });

    test("handles empty strings", () => {
      expect(PerceptualHasher.calculateHammingDistance("", "")).toBe(0);
    });

    test("returns max when one hash is empty", () => {
      expect(PerceptualHasher.calculateHammingDistance("", "1010")).toBe(4);
    });

    test("single bit difference", () => {
      expect(PerceptualHasher.calculateHammingDistance("10000000", "10000001")).toBe(1);
    });
  });

  describe("getPerceptualSimilarity", () => {
    test("returns 100 for identical hashes", () => {
      expect(PerceptualHasher.getPerceptualSimilarity("1010", "1010")).toBe(100);
    });

    test("returns 0 for completely different hashes", () => {
      expect(PerceptualHasher.getPerceptualSimilarity("1111", "0000")).toBe(0);
    });

    test("returns 50 for half-different hashes", () => {
      expect(PerceptualHasher.getPerceptualSimilarity("1100", "1001")).toBe(50);
    });

    test("returns 75 for one-quarter different hashes", () => {
      expect(PerceptualHasher.getPerceptualSimilarity("1111", "1110")).toBe(75);
    });

    test("handles different-length hashes", () => {
      // max distance = 5 (length of longer), distance = 5
      const similarity = PerceptualHasher.getPerceptualSimilarity("111", "00000");
      expect(similarity).toBe(0);
    });
  });

  describe("generatePerceptualHash", () => {
    test("returns empty string for invalid buffer", async () => {
      const result = await PerceptualHasher.generatePerceptualHash(Buffer.from("not an image"));
      expect(result).toBe("");
    });

    test("returns 64-char binary hash for valid image", async () => {
      // Create a minimal valid PNG buffer via jimp
      const { Jimp, rgbaToInt } = await import("jimp");
      const buffer = await new Jimp({ width: 16, height: 16, color: rgbaToInt(128, 128, 128, 255) })
        .getBuffer("image/png");

      const hash = await PerceptualHasher.generatePerceptualHash(buffer);
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[01]+$/);
    });

    test("similar images produce similar hashes", async () => {
      const { Jimp, rgbaToInt } = await import("jimp");
      const buffer1 = await new Jimp({ width: 16, height: 16, color: rgbaToInt(100, 100, 100, 255) })
        .getBuffer("image/png");

      const buffer2 = await new Jimp({ width: 16, height: 16, color: rgbaToInt(105, 105, 105, 255) })
        .getBuffer("image/png");

      const hash1 = await PerceptualHasher.generatePerceptualHash(buffer1);
      const hash2 = await PerceptualHasher.generatePerceptualHash(buffer2);
      const similarity = PerceptualHasher.getPerceptualSimilarity(hash1, hash2);
      expect(similarity).toBeGreaterThan(80);
    });

    test("matches the jimp nearest+greyscale pipeline byte-for-byte (no drift)", async () => {
      // Non-uniform gradient so the hash exercises both 0 and 1 bits and any
      // downscale/greyscale rounding divergence would flip a bit.
      const buffer = await gradientPng(24, 24);
      const golden = await jimpGoldenHash(buffer);

      const hash = await PerceptualHasher.generatePerceptualHash(buffer);

      expect(hash).toBe(golden);
      expect(hash).toMatch(/[1]/); // sanity: not an all-zero degenerate hash
    });

    test("routes decode through backend.rawPixels (no direct jimp dependency)", async () => {
      // 8x8 raw image where the top half is bright and the bottom half is dark:
      // the resulting hash must be the top-32 bits set, bottom-32 clear.
      const backend = new FakeImageBackend();
      const data = Buffer.alloc(8 * 8 * 4);
      for (let i = 0; i < 8 * 8; i++) {
        const v = i < 32 ? 255 : 0;
        data[i * 4] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
      }
      backend.setRawPixelsResult({ width: 8, height: 8, data });

      const hash = await PerceptualHasher.generatePerceptualHash(Buffer.from("src"), backend);

      expect(backend.rawPixelsCalls).toHaveLength(1);
      expect(hash).toBe("1".repeat(32) + "0".repeat(32));
    });

    test("returns empty string when the backend fails to decode", async () => {
      const backend = new FakeImageBackend();
      backend.setShouldThrowOnRawPixels(true);

      const result = await PerceptualHasher.generatePerceptualHash(Buffer.from("bad"), backend);

      expect(result).toBe("");
    });
  });
});
