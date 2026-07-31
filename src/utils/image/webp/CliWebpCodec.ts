import { ActionableError } from "../../../models/ActionableError";
import { WebpBinaryResolver, type WebpBinaryProvider } from "./WebpBinaryResolver";

export interface CliWebpEncodeOptions {
  quality?: number;
  lossless?: boolean;
  nearLossless?: boolean;
}

export function isWebpBuffer(buffer: Buffer): boolean {
  return buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

/**
 * Image-transformation semantics for the WebP leg: build cwebp/dwebp argv from
 * options and sniff the resulting buffers. All process resolution and lifecycle
 * is delegated to the injected {@link WebpBinaryProvider}, the single owner that
 * resolves and executes the libwebp tools.
 */
export class CliWebpCodec {
  constructor(
    private readonly binaryResolver: WebpBinaryProvider = new WebpBinaryResolver()
  ) {}

  async encode(pngBuffer: Buffer, options: CliWebpEncodeOptions = {}): Promise<Buffer> {
    const args = [...buildCwebpOptionArgs(options), "-o", "-", "--", "-"];
    const output = await this.binaryResolver.runCwebp(args, pngBuffer);
    if (!isWebpBuffer(output)) {
      throw new ActionableError("cwebp did not produce a WebP RIFF buffer. Set AUTOMOBILE_CWEBP_PATH to a working cwebp binary.");
    }
    return output;
  }

  async decode(webpBuffer: Buffer): Promise<Buffer> {
    if (!isWebpBuffer(webpBuffer)) {
      throw new ActionableError("CliWebpCodec.decode expected a WebP RIFF buffer.");
    }

    return this.binaryResolver.runDwebp(["-o", "-", "--", "-"], webpBuffer);
  }
}

function buildCwebpOptionArgs(options: CliWebpEncodeOptions): string[] {
  const quality = options.quality ?? 75;
  if (options.nearLossless) {
    return ["-near_lossless", String(quality)];
  }
  if (options.lossless) {
    return ["-lossless", "-q", String(quality)];
  }
  if (options.quality !== undefined) {
    return ["-q", String(quality)];
  }
  return [];
}
