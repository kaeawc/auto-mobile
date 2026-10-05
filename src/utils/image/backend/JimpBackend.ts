import { loadJimp, type JimpConstructor } from "../loadJimp";
import type { ResizeStrategy } from "jimp";
import type {
  ImageBackend,
  ImageMetadata,
  ImageOperation,
  ImagePipeline,
  RawImage,
} from "./ImageBackend";

/**
 * jimp's `ResizeStrategy.NEAREST_NEIGHBOR` value, inlined as a literal. Importing
 * the enum *value* from `jimp` would pull the full package in at module-evaluation
 * time — any module that wires the default backend via `resolveImageBackend()`
 * would then load jimp eagerly, defeating `loadJimp.ts`'s contract that keeps jimp
 * off the MCP startup path. The `import type` above is erased at build time, so the
 * cast stays a pure type reference and adds no runtime dependency.
 */
const NEAREST_NEIGHBOR = "nearestNeighbor" as ResizeStrategy;

// Jimp declares decoded and chained images separately (notably write's
// encoding generics). A pipeline can hold either exact library-declared shape.
type DecodedJimpImage = Awaited<ReturnType<JimpConstructor["fromBuffer"]>>;
type JimpOperationImage = DecodedJimpImage | ReturnType<DecodedJimpImage["resize"]>;

/**
 * Jimp-backed `ImageBackend`. Reproduces exactly what `ImageTransformer` used
 * to run inline for Jimp-supported formats. WebP is intentionally excluded:
 * sharp owns WebP on macOS/Linux and `JimpCliBackend` owns WebP on Windows.
 */
export class JimpBackend implements ImageBackend {
  private applyOperation(image: JimpOperationImage, op: ImageOperation): JimpOperationImage {
    switch (op.type) {
      case "resize": {
        // `"nearest"` forces the nearest-neighbor kernel (no interpolation);
        // omitting `mode` leaves it undefined so jimp uses its default kernel.
        const mode = op.mode === "nearest" ? NEAREST_NEIGHBOR : undefined;
        if (op.height === undefined) {
          // Width only: scale preserving aspect ratio.
          return image.resize({ w: op.width, mode });
        }
        if (op.maintainAspectRatio) {
          // Match sharp's default fit "cover": exact WxH, center-cropped.
          return image.cover({ w: op.width, h: op.height, mode });
        }
        // fit "fill": stretch to exact WxH.
        return image.resize({ w: op.width, h: op.height, mode });
      }
      case "rotate":
        // Jimp uses counter-clockwise degrees; the backend contract is clockwise.
        image.rotate(-op.degrees);
        return image;
      case "crop":
        return image.crop({ x: op.x, y: op.y, w: op.width, h: op.height });
    }
  }

  public async execute(source: Buffer, pipeline: ImagePipeline): Promise<Buffer> {
    const Jimp = await loadJimp();
    let image: JimpOperationImage = await Jimp.fromBuffer(source);
    for (const operation of pipeline.operations) {
      image = this.applyOperation(image, operation);
    }
    // Fall back to the decoded input format when no output encoding was requested.
    const mime = pipeline.encoding?.mime ?? image.mime ?? "image/png";
    if (mime === "image/webp") {
      throw new Error("JimpBackend does not encode WebP; use SharpBackend or JimpCliBackend.");
    }
    return (image.getBuffer as (m: string, o?: Record<string, unknown>) => Promise<Buffer>)(
      mime,
      pipeline.encoding?.options,
    );
  }

  public async metadata(source: Buffer): Promise<ImageMetadata> {
    const Jimp = await loadJimp();
    const image = await Jimp.fromBuffer(source);
    return {
      width: image.bitmap.width,
      height: image.bitmap.height,
      format: image.mime ? image.mime.replace("image/", "") : "",
      size: source.length,
    };
  }

  public async rawPixels(source: Buffer): Promise<RawImage> {
    const Jimp = await loadJimp();
    const image = await Jimp.fromBuffer(source);
    return {
      width: image.bitmap.width,
      height: image.bitmap.height,
      // Copy out of the jimp-owned bitmap so callers can't mutate its internals.
      data: Buffer.from(image.bitmap.data),
    };
  }
}
