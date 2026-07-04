import { ResizeStrategy } from "jimp";
import { loadJimp, type JimpImage } from "../loadJimp";
import type { ImageBackend, ImageMetadata, ImageOperation, ImagePipeline, RawImage } from "./ImageBackend";

/**
 * Jimp-backed `ImageBackend`. Reproduces exactly what `ImageTransformer` used
 * to run inline, including WebP encode/decode via the `@jimp/wasm-webp` plugin
 * (wired in `loadJimp`). Kept pure-jimp for now; sharp/cwebp backends land in
 * later issues (#3010/#3011).
 */
export class JimpBackend implements ImageBackend {
  private applyOperation(image: JimpImage, op: ImageOperation): JimpImage {
    switch (op.type) {
      case "resize": {
        // `"nearest"` forces the nearest-neighbor kernel (no interpolation);
        // omitting `mode` leaves it undefined so jimp uses its default kernel.
        const mode = op.mode === "nearest" ? ResizeStrategy.NEAREST_NEIGHBOR : undefined;
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
      case "crop":
        return image.crop({ x: op.x, y: op.y, w: op.width, h: op.height });
    }
  }

  public async execute(source: Buffer, pipeline: ImagePipeline): Promise<Buffer> {
    const Jimp = await loadJimp();
    let image = await Jimp.fromBuffer(source) as JimpImage;
    for (const operation of pipeline.operations) {
      image = this.applyOperation(image, operation);
    }
    // Fall back to the decoded input format when no output encoding was requested.
    const mime = pipeline.encoding?.mime ?? image.mime ?? "image/png";
    return (image.getBuffer as (m: string, o?: Record<string, unknown>) => Promise<Buffer>)(
      mime,
      pipeline.encoding?.options
    );
  }

  public async metadata(source: Buffer): Promise<ImageMetadata> {
    const Jimp = await loadJimp();
    const image = await Jimp.fromBuffer(source);
    return {
      width: image.bitmap.width,
      height: image.bitmap.height,
      format: image.mime ? image.mime.replace("image/", "") : "",
      size: source.length
    };
  }

  public async rawPixels(source: Buffer): Promise<RawImage> {
    const Jimp = await loadJimp();
    const image = await Jimp.fromBuffer(source);
    return {
      width: image.bitmap.width,
      height: image.bitmap.height,
      // Copy out of the jimp-owned bitmap so callers can't mutate its internals.
      data: Buffer.from(image.bitmap.data)
    };
  }
}
