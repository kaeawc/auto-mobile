import { ScreenshotUtils as ScreenshotUtilsImpl } from "./screenshot/ScreenshotUtils";
import { ScreenshotUtils } from "./interfaces/ScreenshotUtils";
import type { ScreenshotComparisonResult } from "./screenshot/ScreenshotComparator";

// Re-export the interface for consumers
export type { ScreenshotUtils };

/**
 * Adapter class that implements ScreenshotUtils interface
 * Delegates instance method calls to ScreenshotUtils static methods
 */
class ScreenshotUtilsAdapter implements ScreenshotUtils {
  /**
   * Get screenshot from cache or load from disk
   * @param filePath Path to screenshot file
   * @returns Promise with screenshot buffer and perceptual hash
   */
  async getCachedScreenshot(filePath: string): Promise<{ buffer: Buffer; hash: string }> {
    return ScreenshotUtilsImpl.getCachedScreenshot(filePath);
  }

  /**
   * Get image dimensions from buffer
   * @param buffer Image buffer
   * @returns Promise with width and height
   */
  async getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
    return ScreenshotUtilsImpl.getImageDimensions(buffer);
  }

  /**
   * Compare two image buffers and return detailed comparison result
   * @param buffer1 First image buffer
   * @param buffer2 Second image buffer
   * @param threshold Pixelmatch threshold (0-1, default 0.1)
   * @param fastMode Enable fast mode for bulk comparisons (lower quality but faster)
   * @returns Promise with comparison result
   */
  async compareImages(
    buffer1: Buffer,
    buffer2: Buffer,
    threshold?: number,
    fastMode?: boolean,
  ): Promise<ScreenshotComparisonResult> {
    return ScreenshotUtilsImpl.compareImages(buffer1, buffer2, threshold, fastMode);
  }
}

/**
 * Singleton instance of ScreenshotUtilsAdapter
 */
export const screenshotUtilsAdapter = new ScreenshotUtilsAdapter();
