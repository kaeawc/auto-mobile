import { ResizeStrategy } from "jimp";
import { logger } from "../logger";
import { loadJimp } from "../image/loadJimp";

export class PerceptualHasher {
  /**
   * Generate a perceptual hash from image buffer for fast similarity checking
   * @param buffer Image buffer
   * @returns Promise with perceptual hash string
   */
  static async generatePerceptualHash(buffer: Buffer): Promise<string> {
    try {
      const Jimp = await loadJimp();
      // Resize to small standard size for consistent hashing
      const image = await Jimp.fromBuffer(buffer);
      image.resize({ w: 8, h: 8, mode: ResizeStrategy.NEAREST_NEIGHBOR }).greyscale();

      // bitmap.data is RGBA; after greyscale r=g=b, so sample the red channel
      const data = image.bitmap.data;
      const totalPixels = 64; // 8x8
      let sum = 0;
      for (let i = 0; i < totalPixels; i++) {
        sum += data[i * 4];
      }
      const averageValue = sum / totalPixels;

      let hash = "";
      for (let i = 0; i < totalPixels; i++) {
        hash += data[i * 4] > averageValue ? "1" : "0";
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
    return ((maxDistance - distance) / maxDistance) * 100;
  }
}
