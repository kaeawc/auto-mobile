import { logger } from "../logger";
import type { ImageBackend } from "../image/backend/ImageBackend";
import { resolveImageBackend } from "../image/backend/resolveImageBackend";

/** Side length of the downscaled grid used for the perceptual hash (8×8 = 64 bits). */
const HASH_SIZE = 8;

export class PerceptualHasher {
  /**
   * Generate a perceptual hash from image buffer for fast similarity checking
   * @param buffer Image buffer
   * @param backend Image backend used to decode raw pixels (injectable for tests)
   * @returns Promise with perceptual hash string
   */
  static async generatePerceptualHash(
    buffer: Buffer,
    backend: ImageBackend = resolveImageBackend(),
  ): Promise<string> {
    try {
      // Decode once to raw RGBA, then reproduce the former jimp pipeline in place:
      // an 8×8 nearest-neighbor downscale followed by an ITU-R greyscale, so the
      // hash is byte-identical to the pre-seam jimp path (no cache-invalidating drift).
      const raw = await backend.rawPixels(buffer);
      const totalPixels = HASH_SIZE * HASH_SIZE;
      const greys = new Array<number>(totalPixels);
      let sum = 0;

      for (let row = 0; row < HASH_SIZE; row++) {
        // Nearest-neighbor source index, matching jimp's resize2.nearestNeighbor:
        // src = floor(dst * srcDim / dstDim).
        const srcY = Math.floor((row * raw.height) / HASH_SIZE);
        for (let col = 0; col < HASH_SIZE; col++) {
          const srcX = Math.floor((col * raw.width) / HASH_SIZE);
          const idx = (srcY * raw.width + srcX) * 4;
          // ITU Rec 709 luminance, truncated exactly as jimp's greyscale does when
          // it writes the float back into a Uint8 buffer (trunc-toward-zero).
          const grey = Math.trunc(
            0.2126 * raw.data[idx] + 0.7152 * raw.data[idx + 1] + 0.0722 * raw.data[idx + 2],
          );
          greys[row * HASH_SIZE + col] = grey;
          sum += grey;
        }
      }

      const averageValue = sum / totalPixels;

      let hash = "";
      for (let i = 0; i < totalPixels; i++) {
        hash += greys[i] > averageValue ? "1" : "0";
      }

      return hash;
    } catch (error) {
      logger.warn(`Failed to generate perceptual hash: ${(error as Error).message}`);
      return "";
    }
  }

  /**
   * Calculate Hamming distance between two perceptual hashes
   * @param hash1 First perceptual hash
   * @param hash2 Second perceptual hash
   * @returns Hamming distance (lower = more similar)
   */
  static calculateHammingDistance(hash1: string, hash2: string): number {
    if (hash1.length !== hash2.length) {
      return Math.max(hash1.length, hash2.length); // Maximum possible distance
    }

    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
      if (hash1[i] !== hash2[i]) {
        distance++;
      }
    }
    return distance;
  }

  /**
   * Fast similarity check using perceptual hashes
   * @param hash1 First perceptual hash
   * @param hash2 Second perceptual hash
   * @returns Similarity percentage (0-100)
   */
  static getPerceptualSimilarity(hash1: string, hash2: string): number {
    const distance = PerceptualHasher.calculateHammingDistance(hash1, hash2);
    const maxDistance = Math.max(hash1.length, hash2.length);
    // Two empty hashes (e.g. both screenshots failed to hash) carry no bits to
    // differ on. Treat them as identical (100%) rather than returning NaN from
    // the 0/0 division, so failed-vs-failed comparisons are deterministic.
    if (maxDistance === 0) {
      return 100;
    }
    return ((maxDistance - distance) / maxDistance) * 100;
  }
}
