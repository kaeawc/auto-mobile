import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import { NodeCryptoService } from "../crypto";
import { ImageCache } from "./ImageCache";
import { defaultTimer, type Timer } from "../SystemTimer";
import type { ImageBackend, ImageMetadata, ImagePipeline } from "./backend/ImageBackend";
import { resolveImageBackend } from "./backend/resolveImageBackend";

const DEFAULT_WEBP_QUALITY = 75;

// Re-exported from the backend seam so existing importers keep the same path.
export type { ImageMetadata };

/**
 * Fluent builder that records resize/crop/encode requests into a declarative
 * `ImagePipeline` and delegates execution to an injected `ImageBackend`. The
 * backend owns all decode/encode; this class only validates inputs, records the
 * pipeline, and manages the (backend-agnostic) result cache.
 */
class JimpImageTransformer {
  private pipeline: ImagePipeline = { operations: [], encoding: null };
  private cacheKey: string | null = null;
  private useCache: boolean = true;
  private timer: Timer;

  constructor(
    private buffer: Buffer,
    private backend: ImageBackend,
    timer: Timer = defaultTimer,
  ) {
    this.timer = timer;
  }

  private generateCacheKey(): string {
    // Create a unique key based on buffer content hash and the recorded pipeline.
    const pipelineStr = JSON.stringify(this.pipeline);
    const bufferHash = NodeCryptoService.generateCacheKey(this.buffer);
    return `${bufferHash}_${pipelineStr}`;
  }

  public disableCache(): JimpImageTransformer {
    this.useCache = false;
    return this;
  }

  public resize(width: number, height?: number, maintainAspectRatio = true): JimpImageTransformer {
    if (width <= 0) {
      throw new Error("Width must be a positive number");
    }

    if (height !== undefined && height <= 0) {
      throw new Error("Height must be a positive number");
    }

    this.pipeline.operations.push({ type: "resize", width, height, maintainAspectRatio });
    return this;
  }

  public crop(width: number, height: number, x = 0, y = 0): JimpImageTransformer {
    if (width <= 0 || height <= 0) {
      throw new Error("Crop dimensions must be positive numbers");
    }

    this.pipeline.operations.push({ type: "crop", x, y, width, height });
    return this;
  }

  public png(): JimpImageTransformer {
    this.pipeline.encoding = { mime: "image/png" };
    return this;
  }

  /**
   * Convert image to WebP format
   * @param options Configuration options
   * @param options.quality Quality from 1-100 (defaults to 75)
   * @param options.lossless Whether to use lossless compression
   * @param options.nearLossless Whether to use near-lossless compression
   */
  public webp(options?: {
    quality?: number;
    lossless?: boolean;
    nearLossless?: boolean;
  }): JimpImageTransformer {
    const quality = options?.quality || DEFAULT_WEBP_QUALITY;

    if (quality < 1 || quality > 100) {
      throw new Error("WebP quality must be between 1 and 100");
    }

    const webpOptions: Record<string, unknown> = options?.lossless
      ? { lossless: true, quality }
      : options?.nearLossless
        ? { nearLossless: true, quality }
        : { quality };

    this.pipeline.encoding = { mime: "image/webp", options: webpOptions };
    return this;
  }

  public async toBuffer(): Promise<Buffer> {
    const startTime = this.timer.now();
    const formatInfo = this.pipeline.encoding?.mime.replace("image/", "") ?? "unknown";
    logger.debug(`[IMAGE] Starting image processing (format: ${formatInfo})`);

    // Check cache first if cache is enabled
    if (this.useCache) {
      const cacheStartTime = this.timer.now();
      this.cacheKey = this.generateCacheKey();
      const cachedBuffer = ImageCache.getInstance().get(this.cacheKey);
      const cacheDuration = this.timer.now() - cacheStartTime;

      if (cachedBuffer) {
        const totalDuration = this.timer.now() - startTime;
        logger.info(
          `[IMAGE] Cache hit in ${cacheDuration}ms, total: ${totalDuration}ms (${cachedBuffer.length} bytes)`,
        );
        return cachedBuffer;
      }

      logger.debug(`[IMAGE] Cache miss in ${cacheDuration}ms`);
    }

    try {
      const processStartTime = this.timer.now();
      const resultBuffer = await this.backend.execute(this.buffer, this.pipeline);
      const processDuration = this.timer.now() - processStartTime;

      // Store result in cache if caching is enabled
      if (this.useCache && this.cacheKey) {
        const cacheStoreStartTime = this.timer.now();
        ImageCache.getInstance().set(this.cacheKey, resultBuffer);
        const cacheStoreDuration = this.timer.now() - cacheStoreStartTime;
        logger.debug(`[IMAGE] Cache store took ${cacheStoreDuration}ms`);
      }

      const totalDuration = this.timer.now() - startTime;
      logger.info(
        `[IMAGE] Processing completed in ${processDuration}ms, total: ${totalDuration}ms (${this.buffer.length} -> ${resultBuffer.length} bytes)`,
      );
      return resultBuffer;
    } catch (error) {
      const totalDuration = this.timer.now() - startTime;
      logger.warn(
        `[IMAGE] Processing failed after ${totalDuration}ms: ${(error as Error).message}`,
      );
      throw new Error(`Image processing error: ${(error as Error).message}`);
    }
  }
}

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
    buffer: Buffer,
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
