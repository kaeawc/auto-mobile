// Re-export from new location for backward compatibility
export { Image } from "./image/ImageTransformer";

// Import for the interface implementation
import { Image, ImageMetadata } from "./image/ImageTransformer";
import { ImageUtils as ImageUtilsInterface } from "./interfaces/ImageUtils";

/**
 * Backend-based implementation for image utilities.
 */
export class JimpImageUtils implements ImageUtilsInterface {
  public getOriginalBuffer(buffer: Buffer): Buffer {
    return Buffer.from(buffer);
  }

  public async resize(
    buffer: Buffer,
    width: number,
    height?: number,
    maintainAspectRatio = true,
  ): Promise<Buffer> {
    const image = Image.fromBuffer(buffer);
    return image.resize(width, height, maintainAspectRatio).toBuffer();
  }

  public async crop(buffer: Buffer, width: number, height: number, x = 0, y = 0): Promise<Buffer> {
    const image = Image.fromBuffer(buffer);
    return image.crop(width, height, x, y).toBuffer();
  }

  public async toPng(buffer: Buffer): Promise<Buffer> {
    const image = Image.fromBuffer(buffer);
    return image.png().toBuffer();
  }

  public async toWebp(
    buffer: Buffer,
    options?: {
      quality?: number;
      lossless?: boolean;
      nearLossless?: boolean;
    },
  ): Promise<Buffer> {
    const image = Image.fromBuffer(buffer);
    return image.webp(options).toBuffer();
  }

  public async getMetadata(buffer: Buffer): Promise<ImageMetadata> {
    const image = Image.fromBuffer(buffer);
    return image.getMetadata();
  }

  public clearCache(): void {
    Image.clearCache();
  }

  public setCacheSize(megabytes: number): void {
    Image.setCacheSize(megabytes);
  }

  public async batchProcess(
    buffers: Buffer[],
    transform: (buffer: Buffer) => Promise<Buffer>,
  ): Promise<Buffer[]> {
    const tasks = buffers.map((buffer) => transform(buffer));
    return Promise.all(tasks);
  }
}
