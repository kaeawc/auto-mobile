import { errorMessage } from "../../../models/describeUnknownError";
import { logger } from "../../../utils/logger";
import { loadSharp, type SharpFactory } from "../../../utils/image/loadSharp";
import {
  buildPrototypeWebPage,
  MAX_PROTOTYPE_WEB_PAGE_BYTES,
  type PrototypeWebImageRequest,
  type PrototypeWebPage,
  type PrototypeWebPageInput,
} from "./webPage";
import { webImageScaleFactor, type PrototypeWebImage, type WebImageBox } from "./webImages";

/** Where the page reads an asset's original bytes; undefined when the host has none. */
export interface PrototypeWebAssetSource {
  get(id: string): Promise<{ readonly mimeType: string; readonly bytes: Uint8Array } | undefined>;
}

/** Re-encodes one asset as WebP, scaled to serve every box it is drawn in. */
export interface PrototypeWebImageEncoder {
  encode(
    bytes: Uint8Array,
    boxes: readonly WebImageBox[],
  ): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number }>;
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Base64 grows bytes by 4/3; an asset whose data URI alone exceeds the page cannot fit. */
const base64Bytes = (bytes: number) => Math.ceil(bytes / 3) * 4;
export const PROTOTYPE_WEB_IMAGE_WEBP_QUALITY = 80;

/** The repository's image backend (sharp): no enlargement, first frame of an animated image. */
export class SharpPrototypeWebImageEncoder implements PrototypeWebImageEncoder {
  constructor(private readonly load: () => Promise<SharpFactory> = loadSharp) {}

  async encode(bytes: Uint8Array, boxes: readonly WebImageBox[]) {
    const sharp = await this.load();
    const metadata = await sharp(bytes).metadata();
    const width = metadata.width ?? 1;
    const height = metadata.height ?? 1;
    const scale = webImageScaleFactor({ width, height }, boxes);
    const { data, info } = await sharp(bytes)
      .resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        fit: "fill",
      })
      .webp({ quality: PROTOTYPE_WEB_IMAGE_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { bytes: new Uint8Array(data), width: info.width, height: info.height };
  }
}

/**
 * Encodes the requested assets in order, skipping one the host has no image bytes for or cannot
 * decode, and stopping once the encoded total alone would fill the page, since the page could not
 * inline any more.
 */
export async function encodePrototypeWebImages(
  requests: readonly PrototypeWebImageRequest[],
  source: PrototypeWebAssetSource,
  encoder: PrototypeWebImageEncoder,
  maxBytes = MAX_PROTOTYPE_WEB_PAGE_BYTES,
): Promise<PrototypeWebImage[]> {
  const images: PrototypeWebImage[] = [];
  let total = 0;
  for (const request of requests) {
    if (total >= maxBytes) {
      break;
    }
    const asset = await source.get(request.id);
    if (!asset || !IMAGE_MIME_TYPES.has(asset.mimeType)) {
      continue;
    }
    try {
      const encoded = await encoder.encode(asset.bytes, request.boxes);
      images.push({ id: request.id, ...encoded });
      total += base64Bytes(encoded.bytes.byteLength);
    } catch (error) {
      // The page still renders: this asset keeps its placeholder with reason `assetNotInlined`.
      logger.warn(
        `[PROTOTYPE] Could not encode asset ${request.id} for the web page: ${errorMessage(error)}`,
        error,
      );
    }
  }
  return images;
}

/**
 * The page with its assets inlined: one build finds what the views draw and where, the assets are
 * encoded at the largest size the frame draws them, and a second build inlines them while the
 * page budget allows. Without a drawn asset the host has bytes for, it is the first build.
 */
export async function buildPrototypeWebPageWithImages(
  input: PrototypeWebPageInput,
  source: PrototypeWebAssetSource,
  encoder: PrototypeWebImageEncoder,
): Promise<PrototypeWebPage> {
  const first = buildPrototypeWebPage(input);
  if (first.imageRequests.length === 0) {
    return first;
  }
  const images = await encodePrototypeWebImages(
    first.imageRequests,
    source,
    encoder,
    input.maxBytes,
  );
  return images.length === 0 ? first : buildPrototypeWebPage({ ...input, images });
}
