import { loadSharp } from "../loadSharp";
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
  info: { width: number; height: number };
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
export type SharpPort = (input: Buffer) => SharpPipeline;

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

  private async applyPipeline(
    sharp: SharpPort,
    source: Buffer,
    pipeline: ImagePipeline,
  ): Promise<SharpPipeline> {
    let image = sharp(source);
    let hasResizeInCurrentPipeline = false;
    let hasCropInCurrentPipeline = false;
    let hasRotationInCurrentPipeline = false;
    for (const operation of pipeline.operations) {
      if (
        (operation.type === "resize" && hasResizeInCurrentPipeline) ||
        (operation.type === "crop" && hasCropInCurrentPipeline) ||
        (operation.type === "rotate" && (hasResizeInCurrentPipeline || hasCropInCurrentPipeline)) ||
        hasRotationInCurrentPipeline
      ) {
        // Sharp collapses repeated transforms and can move rotation ahead of extract/resize.
        // Materialize at rotation boundaries to preserve the declarative operation order.
        image = sharp(await image.toBuffer());
        hasResizeInCurrentPipeline = false;
        hasCropInCurrentPipeline = false;
        hasRotationInCurrentPipeline = false;
      }
      image = this.applyOperation(image, operation);
      if (operation.type === "resize") {
        hasResizeInCurrentPipeline = true;
      } else if (operation.type === "crop") {
        hasCropInCurrentPipeline = true;
      } else {
        hasRotationInCurrentPipeline = true;
      }
    }

    return this.applyEncoding(image, pipeline);
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
