import { logger } from "../logger";
import { NodeCryptoService } from "../crypto";
import { ImageCache } from "./ImageCache";
import { defaultTimer, type Timer } from "../SystemTimer";
import type { ImageBackend, ImagePipeline } from "./backend/ImageBackend";

const DEFAULT_WEBP_QUALITY = 75;

/**
 * Fluent builder that records resize/crop/encode requests into a declarative
 * `ImagePipeline` and delegates execution to an injected `ImageBackend`. The
 * backend owns all decode/encode; this class only validates inputs, records the
 * pipeline, and manages the (backend-agnostic) result cache.
 */
export class JimpImageTransformer {
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

  public jpeg(options?: { quality?: number }): JimpImageTransformer {
    if (
      options?.quality !== undefined &&
      (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100)
    ) {
      throw new Error("JPEG quality must be an integer between 1 and 100");
    }
    this.pipeline.encoding = {
      mime: "image/jpeg",
      options: options?.quality === undefined ? undefined : { quality: options.quality },
    };
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
