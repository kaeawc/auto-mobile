/**
 * Interface for image utilities.
 * Provides resize/crop, PNG/WebP encoding, and basic metadata
 * (dimensions/format/size). Implemented by JimpImageUtils in ../image-utils.ts.
 */
export interface ImageUtils {
  /**
   * Get the original buffer from an image
   * @param buffer Image buffer
   * @returns Copy of the original buffer
   */
  getOriginalBuffer(buffer: Buffer): Buffer;

  /**
   * Resize an image
   * @param buffer Image buffer
   * @param width Target width
   * @param height Optional target height
   * @param maintainAspectRatio Whether to maintain aspect ratio (default true)
   * @returns Promise with resized buffer
   */
  resize(
    buffer: Buffer,
    width: number,
    height?: number,
    maintainAspectRatio?: boolean,
  ): Promise<Buffer>;

  /**
   * Crop an image
   * @param buffer Image buffer
   * @param width Crop width
   * @param height Crop height
   * @param x X coordinate to start crop (default 0)
   * @param y Y coordinate to start crop (default 0)
   * @returns Promise with cropped buffer
   */
  crop(buffer: Buffer, width: number, height: number, x?: number, y?: number): Promise<Buffer>;

  /**
   * Convert image to PNG format
   * @param buffer Image buffer
   * @returns Promise with PNG buffer
   */
  toPng(buffer: Buffer): Promise<Buffer>;

  /**
   * Convert image to WebP format
   * @param buffer Image buffer
   * @param options WebP options (quality, lossless, nearLossless)
   * @returns Promise with WebP buffer
   */
  toWebp(
    buffer: Buffer,
    options?: {
      quality?: number;
      lossless?: boolean;
      nearLossless?: boolean;
    },
  ): Promise<Buffer>;

  /**
   * Get metadata for an image
   * @param buffer Image buffer
   * @returns Promise with image metadata
   */
  getMetadata(buffer: Buffer): Promise<{
    width: number;
    height: number;
    format: string;
    size: number;
  }>;

  /**
   * Clear the image cache
   */
  clearCache(): void;

  /**
   * Set the maximum cache size in megabytes
   * @param megabytes Cache size in MB
   */
  setCacheSize(megabytes: number): void;

  /**
   * Process multiple images with the same transformations
   * @param buffers Array of image buffers
   * @param transform Transform function to apply to each image
   * @returns Promise with array of transformed buffers
   */
  batchProcess(
    buffers: Buffer[],
    transform: (buffer: Buffer) => Promise<Buffer>,
  ): Promise<Buffer[]>;
}
