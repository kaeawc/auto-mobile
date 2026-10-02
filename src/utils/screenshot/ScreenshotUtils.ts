import { ScreenshotComparator, ScreenshotComparisonResult } from "./ScreenshotComparator";
import { ScreenshotCache } from "./ScreenshotCache";

/**
 * Facade class that maintains backward compatibility with the original ScreenshotUtils API
 * while delegating to specialized classes for each responsibility.
 */
export class ScreenshotUtils {
  /**
   * Get image dimensions from buffer
   * @param buffer Image buffer
   * @returns Promise with width and height
   */
  static async getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
    return ScreenshotComparator.getImageDimensions(buffer);
  }

  /**
   * Compare two image buffers and return detailed comparison result
   * @param buffer1 First image buffer
   * @param buffer2 Second image buffer
   * @param threshold Pixelmatch threshold (0-1, default 0.1)
   * @param fastMode Enable fast mode for bulk comparisons (lower quality but faster)
   * @returns Promise with comparison result
   */
  static async compareImages(
    buffer1: Buffer,
    buffer2: Buffer,
    threshold: number = 0.1,
    fastMode: boolean = false,
  ): Promise<ScreenshotComparisonResult> {
    return ScreenshotComparator.compareImages(buffer1, buffer2, threshold, fastMode);
  }

  /**
   * Get screenshot from cache or load from disk
   * @param filePath Path to screenshot file
   * @returns Promise with screenshot buffer and perceptual hash
   */
  static async getCachedScreenshot(filePath: string): Promise<{ buffer: Buffer; hash: string }> {
    return ScreenshotCache.getCachedScreenshot(filePath);
  }
}
