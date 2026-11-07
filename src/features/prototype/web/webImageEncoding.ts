import { ActionableError } from "../../../models";
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
import { deviceFrameOrThrow } from "./deviceFrames";

/** Where the page reads an asset's original bytes; undefined when the host has none. */
export interface PrototypeWebAssetSource {
  get(id: string): Promise<{ readonly mimeType: string; readonly bytes: Uint8Array } | undefined>;
}

/** How the frame's platform decodes an asset. */
export interface PrototypeWebImageEncodeOptions {
  /** iOS's `UIImage(data:)` applies a JPEG's EXIF orientation; Android's `BitmapFactory` ignores it. */
  readonly applyExifOrientation: boolean;
}

/** Re-encodes one asset as WebP, scaled to serve every box it is drawn in. */
export interface PrototypeWebImageEncoder {
  encode(
    bytes: Uint8Array,
    boxes: readonly WebImageBox[],
    options: PrototypeWebImageEncodeOptions,
  ): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number }>;
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Base64 grows bytes by 4/3; an image whose data URI alone exceeds the page cannot fit. */
const base64Bytes = (bytes: number) => Math.ceil(bytes / 3) * 4;
export const PROTOTYPE_WEB_IMAGE_WEBP_QUALITY = 80;

/**
 * The repository's image backend (sharp): no enlargement, first frame of an animated image. The
 * output carries no metadata, so the browser draws its pixels as stored.
 */
export class SharpPrototypeWebImageEncoder implements PrototypeWebImageEncoder {
  constructor(private readonly load: () => Promise<SharpFactory> = loadSharp) {}

  async encode(
    bytes: Uint8Array,
    boxes: readonly WebImageBox[],
    { applyExifOrientation }: PrototypeWebImageEncodeOptions,
  ) {
    const sharp = await this.load();
    const metadata = await sharp(bytes).metadata();
    // Oriented dimensions swap width and height for EXIF orientations 5 to 8.
    const size = applyExifOrientation ? metadata.autoOrient : metadata;
    const width = size.width ?? 1;
    const height = size.height ?? 1;
    const scale = webImageScaleFactor({ width, height }, boxes);
    const { data, info } = await sharp(bytes, { autoOrient: applyExifOrientation })
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

/** The encoded images, and the ids of those whose data URI alone exceeds the page. */
export interface EncodedPrototypeWebImages {
  readonly images: PrototypeWebImage[];
  readonly overBudget: ReadonlySet<string>;
}

/**
 * Encodes the requested assets in order, skipping one the host has no image bytes for or cannot
 * read or decode, and setting aside one whose data URI alone exceeds the page, since the page could never
 * inline it. The rest are all kept: the page's budget, not the encoded total, decides which fit.
 */
export async function encodePrototypeWebImages(
  requests: readonly PrototypeWebImageRequest[],
  source: PrototypeWebAssetSource,
  encoder: PrototypeWebImageEncoder,
  {
    maxBytes = MAX_PROTOTYPE_WEB_PAGE_BYTES,
    applyExifOrientation = false,
  }: { readonly maxBytes?: number; readonly applyExifOrientation?: boolean } = {},
): Promise<EncodedPrototypeWebImages> {
  const images: PrototypeWebImage[] = [];
  const overBudget = new Set<string>();
  for (const request of requests) {
    try {
      const asset = await source.get(request.id);
      if (!asset || !IMAGE_MIME_TYPES.has(asset.mimeType)) {
        continue;
      }
      const encoded = await encoder.encode(asset.bytes, request.boxes, { applyExifOrientation });
      if (base64Bytes(encoded.bytes.byteLength) <= maxBytes) {
        images.push({ id: request.id, ...encoded });
      } else {
        overBudget.add(request.id);
      }
    } catch (error) {
      // The page still renders: this asset keeps its placeholder with reason `assetNotInlined`.
      logger.warn(
        `[PROTOTYPE] Could not read or encode asset ${request.id} for the web page: ${errorMessage(error)}`,
        error,
      );
    }
  }
  return { images, overBudget };
}

/** The page with these assets' placeholders reported `assetOverBudget`: the host has their bytes. */
function withOverBudget(page: PrototypeWebPage, ids: ReadonlySet<string>): PrototypeWebPage {
  if (ids.size === 0) {
    return page;
  }
  return {
    ...page,
    unsupportedNodes: page.unsupportedNodes.map((node) =>
      node.asset !== undefined && ids.has(node.asset)
        ? { ...node, reason: "assetOverBudget" as const }
        : node,
    ),
  };
}

/** The page with these images inlined, or undefined when their markup alone overflows it. */
function buildWithImages(
  input: PrototypeWebPageInput,
  images: readonly PrototypeWebImage[],
): PrototypeWebPage | undefined {
  try {
    return buildPrototypeWebPage({ ...input, images });
  } catch (error) {
    if (!(error instanceof ActionableError)) {
      throw error;
    }
    // The placeholder build fit, so only the image layers' markup overflowed.
    logger.debug(`[PROTOTYPE] Web page images do not fit: ${errorMessage(error)}`);
    return undefined;
  }
}

type EncodeOptions = Parameters<typeof encodePrototypeWebImages>[3];

/**
 * The second pass when the long-side encodes do not all fit: the assets with compact boxes
 * re-encoded at them, then the page that keeps the most leading images (budget order) at the long
 * side while inlining as many images as with every one compact. Undefined when no asset has
 * compact boxes, so the first pass stands.
 */
async function buildWithCompactImages(
  input: PrototypeWebPageInput,
  first: PrototypeWebPage,
  {
    large,
    fullPage,
  }: {
    readonly large: EncodedPrototypeWebImages;
    readonly fullPage: PrototypeWebPage | undefined;
  },
  {
    source,
    encoder,
    options,
  }: {
    readonly source: PrototypeWebAssetSource;
    readonly encoder: PrototypeWebImageEncoder;
    readonly options: EncodeOptions;
  },
): Promise<PrototypeWebPage | undefined> {
  const largeById = new Map(large.images.map((image) => [image.id, image]));
  const requests = first.imageRequests.flatMap((request) =>
    request.compactBoxes && (largeById.has(request.id) || large.overBudget.has(request.id))
      ? [{ id: request.id, boxes: request.compactBoxes }]
      : [],
  );
  if (requests.length === 0) {
    return undefined;
  }
  const compact = await encodePrototypeWebImages(requests, source, encoder, options);
  const compactById = new Map(compact.images.map((image) => [image.id, image]));
  const ids = first.imageRequests
    .map((request) => request.id)
    .filter((id) => largeById.has(id) || compactById.has(id));
  const builds = new Map<number, PrototypeWebPage | undefined>();
  const build = (keepLarge: number) => {
    if (!builds.has(keepLarge)) {
      const images = ids.map((id, index) =>
        index < keepLarge
          ? (largeById.get(id) ?? compactById.get(id)!)
          : (compactById.get(id) ?? largeById.get(id)!),
      );
      builds.set(keepLarge, buildWithImages(input, images));
    }
    return builds.get(keepLarge);
  };
  const inlined = (page: PrototypeWebPage | undefined) => page?.inlinedImages.length ?? -1;
  const best = inlined(build(0));
  // Only images the first pass inlined ahead of its first overflow can stay large.
  const overflow = fullPage ? ids.findIndex((id) => !fullPage.inlinedImages.includes(id)) : 0;
  let low = 0;
  let high = overflow === -1 ? ids.length : overflow;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (inlined(build(middle)) >= best) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const overBudget = new Set([...large.overBudget].filter((id) => !compactById.has(id)));
  for (const id of compact.overBudget) {
    overBudget.add(id);
  }
  const chosen = build(low);
  return chosen
    ? withOverBudget(chosen, overBudget)
    : withOverBudget(first, new Set([...overBudget, ...ids]));
}

/**
 * The page with its assets inlined: one build finds what the views draw and where, the assets are
 * encoded at the largest size the frame draws them, and a second build inlines them while the
 * page budget allows. When they do not all fit, the assets whose filled axes the portrait width
 * bounds more tightly are re-encoded at it (#16605) and the overflow, then as few earlier images
 * as it takes, draw those compact encodes. Without a drawn asset the host has bytes for, it is
 * the first build. An image draws more markup than a placeholder, so when that markup alone
 * pushes the always-kept views over the budget, the placeholder page stands, its images reported
 * `assetOverBudget`.
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
  const options: EncodeOptions = {
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
    applyExifOrientation: deviceFrameOrThrow(first.frame).platform === "ios",
  };
  const large = await encodePrototypeWebImages(first.imageRequests, source, encoder, options);
  const full = large.images.length === 0 ? undefined : buildWithImages(input, large.images);
  if (full && full.inlinedImages.length === large.images.length && large.overBudget.size === 0) {
    return full;
  }
  const compact = await buildWithCompactImages(
    input,
    first,
    { large, fullPage: full },
    {
      source,
      encoder,
      options,
    },
  );
  if (compact) {
    return compact;
  }
  if (full) {
    return withOverBudget(full, large.overBudget);
  }
  return withOverBudget(
    first,
    new Set([...large.overBudget, ...large.images.map((image) => image.id)]),
  );
}
