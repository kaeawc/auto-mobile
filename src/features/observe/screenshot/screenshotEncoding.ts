import { Image } from "../../../utils/image-utils";
import { detectImageMimeType } from "../../../utils/screenshot/imageHeaderDimensions";
import { validateScreenshotOptions, type ScreenshotEncodingOptions } from "./screenshotOptions";
import type { ScreenshotOptions } from "../TakeScreenshot";

export async function encodeScreenshot(
  source: Buffer,
  options: ScreenshotEncodingOptions,
): Promise<Buffer> {
  const format = options.format ?? "png";
  if (
    detectImageMimeType(source) === `image/${format}` &&
    options.quality === undefined &&
    options.lossless !== true
  ) {
    return source;
  }
  if (!detectImageMimeType(source)) {
    throw new Error("Screenshot has an unsupported image format");
  }
  const image = Image.fromBuffer(source);
  let encoded: Buffer;
  switch (format) {
    case "png":
      encoded = await image.png().toBuffer();
      break;
    case "jpeg":
      encoded = await image.jpeg({ quality: options.quality }).toBuffer();
      break;
    case "webp":
      encoded = await image
        .webp(options.lossless ? { lossless: true } : { quality: options.quality ?? 75 })
        .toBuffer();
      break;
  }
  if (detectImageMimeType(encoded) !== `image/${format}`) {
    throw new Error(`Screenshot encoder did not produce ${format} bytes`);
  }
  return encoded;
}

export function encodingOptions(options: ScreenshotOptions): ScreenshotEncodingOptions {
  return validateScreenshotOptions({
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.quality === undefined ? {} : { quality: options.quality }),
    ...(options.lossless === undefined ? {} : { lossless: options.lossless }),
  });
}
