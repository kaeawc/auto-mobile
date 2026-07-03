import { logger } from "../logger";
import { NodeCryptoService } from "../crypto";
import { ImageCache } from "./ImageCache";
import { defaultTimer, type Timer } from "../SystemTimer";
import { loadJimp, type JimpImage } from "./loadJimp";

const DEFAULT_JPEG_QUALITY = 75;

interface ImageOptions {
  format?: "png" | "webp";
  quality?: number; // 1-100, for webp
  lossless?: boolean;
  nearLossless?: boolean;
  resize?: {
    width?: number;
    height?: number;
    maintainAspectRatio?: boolean;
  };
  crop?: {
    width: number;
    height: number;
    x: number;
    y: number;
  };
}

export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  size: number;
}

type OutputFormat = {
  mime: "image/png" | "image/webp";
  opts?: Record<string, unknown>;
};

class JimpImageTransformer {
  private options: ImageOptions = {};
  private cacheKey: string | null = null;
  private useCache: boolean = true;
  private timer: Timer;
  private operations: Array<(image: JimpImage) => JimpImage> = [];
  private outputFormat: OutputFormat | null = null;

  constructor(private buffer: Buffer, timer: Timer = defaultTimer) {
    this.timer = timer;
  }

  private generateCacheKey(): string {
    // Create a unique key based on buffer content hash and options
    const optionsStr = JSON.stringify(this.options);
    const bufferHash = NodeCryptoService.generateCacheKey(this.buffer);
    return `${bufferHash}_${optionsStr}`;
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

    this.options.resize = {
      width,
      height,
      maintainAspectRatio
    };

    this.operations.push(image => {
      if (height === undefined) {
        // Width only: scale preserving aspect ratio
        return image.resize({ w: width });
      }
      if (maintainAspectRatio) {
        // Match sharp's default fit "cover": exact WxH, center-cropped
        return image.cover({ w: width, h: height });
      }
      // fit "fill": stretch to exact WxH
      return image.resize({ w: width, h: height });
    });
    return this;
  }

  public crop(width: number, height: number, x = 0, y = 0): JimpImageTransformer {
    if (width <= 0 || height <= 0) {
      throw new Error("Crop dimensions must be positive numbers");
    }

    this.options.crop = { width, height, x, y };
    this.operations.push(image => image.crop({ x, y, w: width, h: height }));
    return this;
  }

  public png(): JimpImageTransformer {
    this.options.format = "png";
    this.outputFormat = { mime: "image/png" };
    return this;
  }

  /**
   * Convert image to WebP format
   * @param options Configuration options
   * @param options.quality Quality from 1-100 (defaults to 75)
   * @param options.lossless Whether to use lossless compression
   * @param options.nearLossless Whether to use near-lossless compression
   */
  public webp(options?: { quality?: number; lossless?: boolean; nearLossless?: boolean }): JimpImageTransformer {
    const quality = options?.quality || DEFAULT_JPEG_QUALITY;

    if (quality < 1 || quality > 100) {
      throw new Error("WebP quality must be between 1 and 100");
    }

    this.options.format = "webp";
    this.options.quality = quality;
    this.options.lossless = options?.lossless;
    this.options.nearLossless = options?.nearLossless;

    // The wasm-webp encoder takes libwebp-style numeric flags. Keys are
    // camelCase (validated by the plugin's zod schema — an unknown key is
    // silently dropped, and `quality` defaults to 100). In lossless mode
    // `quality` still controls compression effort/ratio, so pass it through.
    // near-lossless runs inside lossless mode; sharp used `quality` as the
    // near-lossless preprocessing level, so mirror that.
    const webpOptions: Record<string, unknown> = options?.lossless
      ? { lossless: 1, quality }
      : options?.nearLossless
        ? { lossless: 1, nearLossless: quality }
        : { quality };

    this.outputFormat = { mime: "image/webp", opts: webpOptions };
    return this;
  }

  public async toBuffer(): Promise<Buffer> {
    const startTime = this.timer.now();
    const formatInfo = this.options.format || "unknown";
    logger.debug(`[IMAGE] Starting image processing (format: ${formatInfo})`);

    // Check cache first if cache is enabled
    if (this.useCache) {
      const cacheStartTime = this.timer.now();
      this.cacheKey = this.generateCacheKey();
      const cachedBuffer = ImageCache.getInstance().get(this.cacheKey);
      const cacheDuration = this.timer.now() - cacheStartTime;

      if (cachedBuffer) {
        const totalDuration = this.timer.now() - startTime;
        logger.info(`[IMAGE] Cache hit in ${cacheDuration}ms, total: ${totalDuration}ms (${cachedBuffer.length} bytes)`);
        return cachedBuffer;
      }

      logger.debug(`[IMAGE] Cache miss in ${cacheDuration}ms`);
    }

    try {
      const processStartTime = this.timer.now();
      const Jimp = await loadJimp();
      let image = await Jimp.fromBuffer(this.buffer) as JimpImage;
      for (const operation of this.operations) {
        image = operation(image);
      }
      // Fall back to the decoded input format when no output format was requested
      const mime = this.outputFormat?.mime ?? image.mime ?? "image/png";
      const resultBuffer = await (image.getBuffer as (m: string, o?: Record<string, unknown>) => Promise<Buffer>)(
        mime,
        this.outputFormat?.opts
      );
      const processDuration = this.timer.now() - processStartTime;

      // Store result in cache if caching is enabled
      if (this.useCache && this.cacheKey) {
        const cacheStoreStartTime = this.timer.now();
        ImageCache.getInstance().set(this.cacheKey, resultBuffer);
        const cacheStoreDuration = this.timer.now() - cacheStoreStartTime;
        logger.debug(`[IMAGE] Cache store took ${cacheStoreDuration}ms`);
      }

      const totalDuration = this.timer.now() - startTime;
      logger.info(`[IMAGE] Processing completed in ${processDuration}ms, total: ${totalDuration}ms (${this.buffer.length} -> ${resultBuffer.length} bytes)`);
      return resultBuffer;
    } catch (error) {
      const totalDuration = this.timer.now() - startTime;
      logger.warn(`[IMAGE] Processing failed after ${totalDuration}ms: ${(error as Error).message}`);
      throw new Error(`Image processing error: ${(error as Error).message}`);
    }
  }
}

export class Image {
  private timer: Timer;

  constructor(private buffer: Buffer, timer: Timer = defaultTimer) {
    this.timer = timer;
  }

  public static fromBuffer(buffer: Buffer, timer: Timer = defaultTimer): Image {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error("Input must be a Buffer");
    }
    return new Image(buffer, timer);
  }

  public getOriginalBuffer(): Buffer {
    return Buffer.from(this.buffer);
  }

  public resize(width: number, height?: number, maintainAspectRatio = true): JimpImageTransformer {
    return new JimpImageTransformer(this.buffer, this.timer).resize(width, height, maintainAspectRatio);
  }

  public crop(width: number, height: number, x = 0, y = 0): JimpImageTransformer {
    return new JimpImageTransformer(this.buffer, this.timer).crop(width, height, x, y);
  }

  public png(): JimpImageTransformer {
    return new JimpImageTransformer(this.buffer, this.timer).png();
  }

  /**
   * Convert the image to WebP format
   */
  public webp(options?: { quality?: number; lossless?: boolean; nearLossless?: boolean }): JimpImageTransformer {
    return new JimpImageTransformer(this.buffer, this.timer).webp(options);
  }

  public transform(): JimpImageTransformer {
    return new JimpImageTransformer(this.buffer, this.timer);
  }

  /**
   * Get metadata for the image
   */
  public async getMetadata(): Promise<ImageMetadata> {
    try {
      const Jimp = await loadJimp();
      const image = await Jimp.fromBuffer(this.buffer);

      return {
        width: image.bitmap.width,
        height: image.bitmap.height,
        format: image.mime ? image.mime.replace("image/", "") : "",
        size: this.buffer.length
      };
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to get image metadata: ${errorMessage}`);
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
