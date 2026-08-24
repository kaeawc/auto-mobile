import { loadSharp, type SharpFactory } from "../loadSharp";
import type {
  ImageBackend,
  ImageMetadata,
  ImageOperation,
  ImagePipeline,
  RawImage,
} from "./ImageBackend";

export type SharpLoader = () => Promise<SharpFactory>;

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
    operation: (sharp: SharpFactory) => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    let sharp: SharpFactory;
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

  private applyOperation(
    image: ReturnType<SharpFactory>,
    op: ImageOperation,
  ): ReturnType<SharpFactory> {
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
      case "crop":
        return image.extract({ left: op.x, top: op.y, width: op.width, height: op.height });
    }
  }

  private applyEncoding(
    image: ReturnType<SharpFactory>,
    pipeline: ImagePipeline,
  ): ReturnType<SharpFactory> {
    switch (pipeline.encoding?.mime) {
      case "image/png":
        return image.png();
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
    sharp: SharpFactory,
    source: Buffer,
    pipeline: ImagePipeline,
  ): Promise<ReturnType<SharpFactory>> {
    let image = sharp(source);
    let hasResizeInCurrentPipeline = false;
    let hasCropInCurrentPipeline = false;
    for (const operation of pipeline.operations) {
      if (
        (operation.type === "resize" && hasResizeInCurrentPipeline) ||
        (operation.type === "crop" && hasCropInCurrentPipeline)
      ) {
        // Sharp collapses some repeated operations in one pipeline; materialize only at compatibility boundaries.
        image = sharp(await image.toBuffer());
        hasResizeInCurrentPipeline = false;
        hasCropInCurrentPipeline = false;
      }
      image = this.applyOperation(image, operation);
      if (operation.type === "resize") {
        hasResizeInCurrentPipeline = true;
      } else {
        hasCropInCurrentPipeline = true;
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
