import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { ImageCache } from "./ImageCache";
import { JimpImageTransformer } from "./JimpImageTransformer";
import { defaultTimer, type Timer } from "../SystemTimer";
import type { ImageBackend, ImageMetadata } from "./backend/ImageBackend";
import { resolveImageBackend } from "./backend/resolveImageBackend";

// Re-exported from the backend seam so existing importers keep the same path.
export type { ImageMetadata };

export class Image {
  private timer: Timer;
  private backend: ImageBackend;

  constructor(
    private buffer: Buffer,
    timer: Timer = defaultTimer,
    backend: ImageBackend = resolveImageBackend(),
  ) {
    this.timer = timer;
    this.backend = backend;
  }

  public static fromBuffer(
    buffer: unknown,
    timer: Timer = defaultTimer,
    backend: ImageBackend = resolveImageBackend(),
  ): Image {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error("Input must be a Buffer");
    }
    return new Image(buffer, timer, backend);
  }

  public getOriginalBuffer(): Buffer {
    return Buffer.from(this.buffer);
  }

  public resize(width: number, height?: number, maintainAspectRatio = true): JimpImageTransformer {
    return new JimpImageTransformer(this.buffer, this.backend, this.timer).resize(
      width,
      height,
      maintainAspectRatio,
    );
  }

  public crop(width: number, height: number, x = 0, y = 0): JimpImageTransformer {
    return new JimpImageTransformer(this.buffer, this.backend, this.timer).crop(
      width,
      height,
      x,
      y,
    );
  }

  public png(): JimpImageTransformer {
    return new JimpImageTransformer(this.buffer, this.backend, this.timer).png();
  }

  public jpeg(options?: { quality?: number }): JimpImageTransformer {
    return new JimpImageTransformer(this.buffer, this.backend, this.timer).jpeg(options);
  }

  /**
   * Convert the image to WebP format
   */
  public webp(options?: {
    quality?: number;
    lossless?: boolean;
    nearLossless?: boolean;
  }): JimpImageTransformer {
    return new JimpImageTransformer(this.buffer, this.backend, this.timer).webp(options);
  }

  public transform(): JimpImageTransformer {
    return new JimpImageTransformer(this.buffer, this.backend, this.timer);
  }

  /**
   * Get metadata for the image
   */
  public async getMetadata(): Promise<ImageMetadata> {
    try {
      return await this.backend.metadata(this.buffer);
    } catch (e: unknown) {
      const errorMsg = errorMessage(e);
      // Log before rethrowing so the underlying decode error leaves a trace,
      // mirroring toBuffer's catch (the summarized message loses the original).
      logger.warn(`[IMAGE] Metadata read failed: ${errorMsg}`, e);
      throw new Error(`Failed to get image metadata: ${errorMsg}`);
    }
  }

  // Enhanced utility methods

  public static clearCache(): void {
    ImageCache.getInstance().clear();
  }

  public static setCacheSize(megabytes: number): void {
    ImageCache.getInstance().setMaxSize(megabytes * 1024 * 1024);
  }
}
