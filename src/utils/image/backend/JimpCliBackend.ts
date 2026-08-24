import type { CliWebpEncodeOptions } from "../webp/CliWebpCodec";
import { CliWebpCodec, isWebpBuffer } from "../webp/CliWebpCodec";
import type { ImageBackend, ImageMetadata, ImagePipeline, RawImage } from "./ImageBackend";
import { JimpBackend } from "./JimpBackend";

export interface WebpCodec {
  encode(pngBuffer: Buffer, options?: CliWebpEncodeOptions): Promise<Buffer>;
  decode(webpBuffer: Buffer): Promise<Buffer>;
}

export interface JimpCliBackendOptions {
  jimpBackend?: ImageBackend;
  webpCodec?: WebpCodec;
}

/**
 * Windows image backend: Jimp handles decode/resize/crop/PNG/raw pixels, while
 * native libwebp CLI tools handle the WebP leg through `CliWebpCodec`.
 */
export class JimpCliBackend implements ImageBackend {
  private readonly jimpBackend: ImageBackend;
  private readonly webpCodec: WebpCodec;

  constructor(options: JimpCliBackendOptions = {}) {
    this.jimpBackend = options.jimpBackend ?? new JimpBackend();
    this.webpCodec = options.webpCodec ?? new CliWebpCodec();
  }

  async execute(source: Buffer, pipeline: ImagePipeline): Promise<Buffer> {
    const sourceIsWebp = isWebpBuffer(source);
    const decodedSource = sourceIsWebp ? await this.webpCodec.decode(source) : source;
    const requestedEncoding = pipeline.encoding?.mime;

    if (requestedEncoding === "image/webp" || (pipeline.encoding === null && sourceIsWebp)) {
      const png = await this.jimpBackend.execute(decodedSource, {
        operations: pipeline.operations,
        encoding: { mime: "image/png" },
      });
      return this.webpCodec.encode(png, toCliWebpEncodeOptions(pipeline.encoding?.options));
    }

    return this.jimpBackend.execute(decodedSource, pipeline);
  }

  async metadata(source: Buffer): Promise<ImageMetadata> {
    if (!isWebpBuffer(source)) {
      return this.jimpBackend.metadata(source);
    }

    const png = await this.webpCodec.decode(source);
    const metadata = await this.jimpBackend.metadata(png);
    return {
      ...metadata,
      format: "webp",
      size: source.length,
    };
  }

  async rawPixels(source: Buffer): Promise<RawImage> {
    const decodedSource = isWebpBuffer(source) ? await this.webpCodec.decode(source) : source;
    return this.jimpBackend.rawPixels(decodedSource);
  }
}

function toCliWebpEncodeOptions(options?: Record<string, unknown>): CliWebpEncodeOptions {
  const result: CliWebpEncodeOptions = {};
  if (typeof options?.quality === "number") {
    result.quality = options.quality;
  }
  if (options?.lossless === true) {
    result.lossless = true;
  }
  if (options?.nearLossless === true) {
    result.nearLossless = true;
  }
  return result;
}
