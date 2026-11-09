import { loadSharp } from "../loadSharp";
import { detectImageMimeType } from "../../screenshot/imageHeaderDimensions";
import type {
  ImageBackend,
  ImageMetadata,
  ImageOperation,
  ImagePipeline,
  RawImage,
} from "./ImageBackend";

export interface SharpResizeOptions {
  width: number;
  height?: number;
  fit?: "cover" | "fill";
  kernel?: "nearest";
}

export interface SharpExtractRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SharpWebpOptions {
  quality?: number;
  lossless?: true;
  nearLossless?: true;
}

export interface SharpRawResult {
  data: Uint8Array;
  info: { width: number; height: number; channels?: number };
}

/** Decoded pixel layout for a raw (unencoded) sharp input. */
export interface SharpRawInput {
  raw: { width: number; height: number; channels: 1 | 2 | 3 | 4 };
}

/** The slice of a sharp pipeline that SharpBackend drives. */
export interface SharpPipeline {
  resize(options: SharpResizeOptions): SharpPipeline;
  rotate(degrees: number): SharpPipeline;
  extract(region: SharpExtractRegion): SharpPipeline;
  png(): SharpPipeline;
  jpeg(options: { quality?: number }): SharpPipeline;
  webp(options: SharpWebpOptions): SharpPipeline;
  ensureAlpha(): SharpPipeline;
  raw(): SharpPipeline;
  metadata(): Promise<{ width?: number; height?: number; format?: string }>;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: { resolveWithObject: true }): Promise<SharpRawResult>;
}

/** The slice of the sharp module entry point that SharpBackend uses. */
export type SharpPort = (input: Buffer, options?: SharpRawInput) => SharpPipeline;

export type SharpLoader = () => Promise<SharpPort>;

export interface SharpBackendOptions {
  loadSharp?: SharpLoader;
  fallbackBackend?: ImageBackend;
}

/**
 * sharp-backed `ImageBackend` used on macOS/Linux. The sharp module is loaded
 * lazily so image processing does not add native startup work to the MCP server.
 * If module discovery fails, operations delegate to the configured JimpBackend
 * fallback; native sharp aborts are not catchable and remain out of scope.
 */
export class SharpBackend implements ImageBackend {
  private readonly loadSharp: SharpLoader;
  private readonly fallbackBackend: ImageBackend | undefined;

  constructor(options: SharpBackendOptions = {}) {
    this.loadSharp = options.loadSharp ?? loadSharp;
    this.fallbackBackend = options.fallbackBackend;
  }

  private async withSharp<T>(
    operation: (sharp: SharpPort) => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    let sharp: SharpPort;
    try {
      sharp = await this.loadSharp();
    } catch {
      if (this.fallbackBackend) {
        return fallback();
      }
      throw new Error("sharp is not available");
    }
    return operation(sharp);
  }

  private applyOperation(image: SharpPipeline, op: ImageOperation): SharpPipeline {
    switch (op.type) {
      case "resize": {
        const kernel = op.mode === "nearest" ? "nearest" : undefined;
        if (op.height === undefined) {
          return image.resize({ width: op.width, kernel });
        }
        return image.resize({
          width: op.width,
          height: op.height,
          fit: op.maintainAspectRatio ? "cover" : "fill",
          kernel,
        });
      }
      case "rotate":
        return image.rotate(op.degrees);
      case "crop":
        return image.extract({ left: op.x, top: op.y, width: op.width, height: op.height });
    }
  }

  private applyEncoding(image: SharpPipeline, pipeline: ImagePipeline): SharpPipeline {
    switch (pipeline.encoding?.mime) {
      case "image/png":
        return image.png();
      case "image/jpeg":
        return image.jpeg({ quality: pipeline.encoding.options?.quality as number | undefined });
      case "image/webp": {
        const options = pipeline.encoding.options;
        return image.webp({
          quality: typeof options?.quality === "number" ? options.quality : undefined,
          lossless: options?.lossless === true ? true : undefined,
          nearLossless: options?.nearLossless === true ? true : undefined,
        });
      }
      default:
        return image;
    }
  }

  /**
   * Materialize the pipeline so far as decoded pixels, not an encoded image. A full-resolution
   * PNG/JPEG intermediate would be encoded and decoded again before a later resize, so the
   * only encode a pipeline pays for is the final one, at the output size.
   */
  private async materializeRaw(sharp: SharpPort, image: SharpPipeline): Promise<SharpPipeline> {
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const channels = info.channels ?? 4;
    if (channels !== 1 && channels !== 2 && channels !== 3 && channels !== 4) {
      throw new Error(`sharp returned an unsupported raw channel count: ${channels}`);
    }
    return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width: info.width, height: info.height, channels },
    });
  }

  private async applyPipeline(
    sharp: SharpPort,
    source: Buffer,
    pipeline: ImagePipeline,
  ): Promise<SharpPipeline> {
    // A raw intermediate drops the input format, so an unspecified output encoding is pinned to
    // the source format. Sources whose format is not known keep the encoded intermediate.
    const sourceMime = detectImageMimeType(source);
    const encoding = pipeline.encoding ?? (sourceMime ? { mime: sourceMime } : null);
    let materialized = false;
    let image = sharp(source);
    let pending = new Set<ImageOperation["type"]>();
    for (const operation of pipeline.operations) {
      if (needsMaterialization(operation.type, pending)) {
        // Sharp collapses repeated transforms and can move rotation ahead of extract/resize.
        // Materialize at rotation boundaries to preserve the declarative operation order.
        image = encoding ? await this.materializeRaw(sharp, image) : sharp(await image.toBuffer());
        materialized = true;
        pending = new Set();
      }
      image = this.applyOperation(image, operation);
      pending.add(operation.type);
    }

    return this.applyEncoding(image, {
      ...pipeline,
      encoding: materialized ? encoding : pipeline.encoding,
    });
  }

  public async execute(source: Buffer, pipeline: ImagePipeline): Promise<Buffer> {
    return this.withSharp(
      async (sharp) => (await this.applyPipeline(sharp, source, pipeline)).toBuffer(),
      () => this.fallbackBackend!.execute(source, pipeline),
    );
  }

  public async metadata(source: Buffer): Promise<ImageMetadata> {
    return this.withSharp(
      async (sharp) => {
        const metadata = await sharp(source).metadata();
        return {
          width: metadata.width ?? 0,
          height: metadata.height ?? 0,
          format: metadata.format ?? "",
          size: source.length,
        };
      },
      () => this.fallbackBackend!.metadata(source),
    );
  }

  public async rawPixels(source: Buffer): Promise<RawImage> {
    return this.withSharp(
      async (sharp) => {
        const { data, info } = await sharp(source)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return {
          width: info.width,
          height: info.height,
          data: Buffer.from(data),
        };
      },
      () => this.fallbackBackend!.rawPixels(source),
    );
  }
}

/** Whether `next` must start a fresh sharp pipeline given the operations already chained. */
function needsMaterialization(
  next: ImageOperation["type"],
  pending: ReadonlySet<ImageOperation["type"]>,
): boolean {
  if (pending.has("rotate") || pending.has(next)) {
    return true;
  }
  return next === "rotate" && (pending.has("resize") || pending.has("crop"));
}
