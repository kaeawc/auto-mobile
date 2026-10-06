import type { ScreenshotComparisonResult } from "../screenshot/ScreenshotComparator";

/**
 * Interface for screenshot utilities
 * Provides image manipulation, comparison, and analysis capabilities
 */
export interface ScreenshotUtils {
  /**
   * Get screenshot from cache or load from disk
   * @param filePath Path to screenshot file
   * @returns Promise with screenshot buffer and perceptual hash
   */
  getCachedScreenshot(filePath: string): Promise<{ buffer: Buffer; hash: string }>;

  /**
   * Get image dimensions from buffer
   * @param buffer Image buffer
   * @returns Promise with width and height
   */
  getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }>;

  /**
   * Compare two image buffers and return detailed comparison result
   * @param buffer1 First image buffer
   * @param buffer2 Second image buffer
   * @param threshold Pixelmatch threshold (0-1, default 0.1)
   * @param fastMode Enable fast mode for bulk comparisons (lower quality but faster)
   * @returns Promise with comparison result
   */
  compareImages(
    buffer1: Buffer,
    buffer2: Buffer,
    threshold?: number,
    fastMode?: boolean,
  ): Promise<ScreenshotComparisonResult>;
}
