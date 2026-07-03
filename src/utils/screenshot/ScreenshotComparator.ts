import { PNG } from "pngjs";
import { ResizeStrategy } from "jimp";
import { logger } from "../logger";
import { Timer, defaultTimer } from "../SystemTimer";
import { loadJimp } from "../image/loadJimp";

// Add dynamic import function for pixelmatch
async function getPixelmatch() {
  const { default: pixelmatch } = await import("pixelmatch");
  return pixelmatch;
}

export interface ScreenshotComparisonResult {
  similarity: number; // 0-100 percentage
  pixelDifference: number;
  totalPixels: number;
  filePath?: string;
}

export class ScreenshotComparator {
  private static readonly PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  /**
   * Check if a buffer contains PNG image data
   * @param buffer Buffer to check
   * @returns True if buffer appears to be PNG data
   */
  static isPngBuffer(buffer: Buffer): boolean {
    if (buffer.length < 8) {
      return false;
    }
    return buffer.subarray(0, 8).equals(ScreenshotComparator.PNG_HEADER);
  }

  /**
   * Convert image buffer to PNG format
   * @param buffer Input image buffer
   * @returns Promise with PNG buffer
   */
  static async convertToPng(buffer: Buffer): Promise<Buffer> {
    try {
      const Jimp = await loadJimp();
      const image = await Jimp.fromBuffer(buffer);
      return await image.getBuffer("image/png");
    } catch (error) {
      throw new Error(`Failed to convert image to PNG: ${(error as Error).message}`);
    }
  }

  /**
   * Get image dimensions from buffer
   * @param buffer Image buffer
   * @returns Promise with width and height
   */
  static async getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
    // Fast path: PNG stores dimensions in the IHDR chunk, no full decode needed
    if (ScreenshotComparator.isPngBuffer(buffer) && buffer.length >= 24) {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20)
      };
    }

    try {
      const Jimp = await loadJimp();
      const image = await Jimp.fromBuffer(buffer);
      return {
        width: image.bitmap.width,
        height: image.bitmap.height
      };
    } catch (error) {
      throw new Error(`Failed to get image dimensions: ${(error as Error).message}`);
    }
  }

  /**
   * Resize image to match dimensions if needed
   * @param buffer Image buffer to resize
   * @param targetWidth Target width
   * @param targetHeight Target height
   * @returns Promise with resized buffer
   */
  static async resizeImageIfNeeded(
    buffer: Buffer,
    targetWidth: number,
    targetHeight: number
  ): Promise<Buffer> {
    const { width, height } = await ScreenshotComparator.getImageDimensions(buffer);

    if (width === targetWidth && height === targetHeight) {
      return buffer;
    }

    logger.debug(`Resizing image from ${width}x${height} to ${targetWidth}x${targetHeight}`);

    try {
      const Jimp = await loadJimp();
      const image = await Jimp.fromBuffer(buffer);
      // Nearest-neighbor stretch to exact target size — fast resize for comparison purposes
      image.resize({ w: targetWidth, h: targetHeight, mode: ResizeStrategy.NEAREST_NEIGHBOR });
      return await image.getBuffer("image/png");
    } catch (error) {
      throw new Error(`Failed to resize image: ${(error as Error).message}`);
    }
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
    timer: Timer = defaultTimer
  ): Promise<ScreenshotComparisonResult> {
    const comparisonStart = timer.now();
    logger.debug(`Starting image comparison with threshold ${threshold}${fastMode ? " (fast mode)" : ""}`);

    try {
      // Ensure both images are PNG format
      let png1Buffer = ScreenshotComparator.isPngBuffer(buffer1) ? buffer1 : await ScreenshotComparator.convertToPng(buffer1);
      let png2Buffer = ScreenshotComparator.isPngBuffer(buffer2) ? buffer2 : await ScreenshotComparator.convertToPng(buffer2);

      // Get dimensions
      const dims1 = await ScreenshotComparator.getImageDimensions(png1Buffer);
      const dims2 = await ScreenshotComparator.getImageDimensions(png2Buffer);

      logger.debug(`Image 1 dimensions: ${dims1.width}x${dims1.height}`);
      logger.debug(`Image 2 dimensions: ${dims2.width}x${dims2.height}`);

      // In fast mode, use smaller target dimensions for quicker comparison
      const targetWidth = fastMode
        ? Math.min(dims1.width, dims2.width, 400) // Cap at 400px width for fast mode
        : Math.min(dims1.width, dims2.width);
      const targetHeight = fastMode
        ? Math.min(dims1.height, dims2.height, 600) // Cap at 600px height for fast mode
        : Math.min(dims1.height, dims2.height);

      // Resize images to match if needed (use the smaller dimensions for performance)
      if (dims1.width !== targetWidth || dims1.height !== targetHeight) {
        png1Buffer = await ScreenshotComparator.resizeImageIfNeeded(png1Buffer, targetWidth, targetHeight);
      }
      if (dims2.width !== targetWidth || dims2.height !== targetHeight) {
        png2Buffer = await ScreenshotComparator.resizeImageIfNeeded(png2Buffer, targetWidth, targetHeight);
      }

      // Parse PNG data
      const img1 = PNG.sync.read(png1Buffer);
      const img2 = PNG.sync.read(png2Buffer);

      const { width, height } = img1;
      const totalPixels = width * height;

      logger.debug(`Comparing images: ${width}x${height} (${totalPixels} pixels)`);

      // Perform pixel comparison with adjusted threshold for fast mode
      const adjustedThreshold = fastMode ? Math.min(threshold * 1.5, 0.2) : threshold;
      const pixelmatch = await getPixelmatch();
      const pixelDifference = pixelmatch(
        img1.data,
        img2.data,
        undefined, // No diff output needed
        width,
        height,
        {
          threshold: adjustedThreshold,
          includeAA: false // Ignore anti-aliased pixels
        }
      );

      const similarity = ((totalPixels - pixelDifference) / totalPixels) * 100;
      const comparisonTime = timer.now() - comparisonStart;

      logger.debug(`Image comparison completed in ${comparisonTime}ms: ${pixelDifference}/${totalPixels} different pixels (${similarity.toFixed(2)}% similar)`);

      return {
        similarity,
        pixelDifference,
        totalPixels
      };
    } catch (error) {
      const comparisonTime = timer.now() - comparisonStart;
      logger.warn(`Image comparison failed after ${comparisonTime}ms: ${(error as Error).message}`);

      return {
        similarity: 0,
        pixelDifference: -1,
        totalPixels: 0
      };
    }
  }
}
