import { pathToFileURL } from "node:url";
import { ActionableError } from "../../../../models/ActionableError";
import type { ImageBackend, RawImage } from "../../../../utils/image/backend/ImageBackend";
import { JimpBackend } from "../../../../utils/image/backend/JimpBackend";
import { loadJimp, type JimpConstructor } from "../../../../utils/image/loadJimp";
import {
  detectImageMimeType,
  readImageHeaderDimensions,
} from "../../../../utils/screenshot/imageHeaderDimensions";
import { contrastRatio, type Rgba } from "../../prototypeContrast";

const CANVAS_SIZE = 432;
/** The 66dp adaptive-icon safe zone is a circle; launcher masks may clip anything outside it. */
const SAFE_DIAMETER = 264;
const GLYPH_SIZE = 288;
/** Rejects artwork whose header declares more pixels than this before it is decoded. */
export const MAX_ICON_ASSET_PIXELS = 4096 * 4096;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

export interface AndroidIconLayers {
  foreground: Buffer;
  monochrome: Buffer;
}

type IconSource = { bytes: Uint8Array } | { label: string; background: Rgba };

export interface AndroidIconRenderer {
  render(source: IconSource): Promise<AndroidIconLayers>;
}

function loadMonogramFont() {
  return Promise.all([import("jimp"), import("jimp/fonts")]).then(
    ([{ loadFont }, { SANS_128_BLACK }]) => {
      // Jimp detects Bun as a worker and reads the font with fetch.
      return loadFont(
        typeof Bun === "undefined" ? SANS_128_BLACK : pathToFileURL(SANS_128_BLACK).href,
      );
    },
  );
}

export class DefaultAndroidIconRenderer implements AndroidIconRenderer {
  private font?: ReturnType<typeof loadMonogramFont>;

  constructor(
    private readonly backend: Pick<ImageBackend, "rawPixels"> = new JimpBackend(),
    private readonly jimpLoader: () => Promise<JimpConstructor> = loadJimp,
  ) {}

  async render(source: IconSource): Promise<AndroidIconLayers> {
    const artwork =
      "bytes" in source
        ? await this.assetArtwork(source.bytes)
        : await this.monogram(source.label, source.background);
    const Jimp = await this.jimpLoader();

    // Fit the artwork's diagonal to the safe circle so its corners stay unmasked.
    const scale = SAFE_DIAMETER / Math.hypot(artwork.width, artwork.height);
    artwork.resize({
      w: Math.max(1, Math.floor(artwork.width * scale)),
      h: Math.max(1, Math.floor(artwork.height * scale)),
    });
    const foreground = new Jimp({ width: CANVAS_SIZE, height: CANVAS_SIZE });
    const monochrome = new Jimp({ width: CANVAS_SIZE, height: CANVAS_SIZE });
    const left = Math.floor((CANVAS_SIZE - artwork.width) / 2);
    const top = Math.floor((CANVAS_SIZE - artwork.height) / 2);
    const rowBytes = artwork.width * 4;
    const pixels = artwork.bitmap.data;
    for (let y = 0; y < artwork.height; y += 1) {
      const start = (top + y) * CANVAS_SIZE * 4 + left * 4;
      pixels.copy(foreground.bitmap.data, start, y * rowBytes, (y + 1) * rowBytes);
      for (let x = 3; x < rowBytes; x += 4) {
        monochrome.bitmap.data[start + x] = pixels[y * rowBytes + x]!;
      }
    }
    return {
      foreground: await foreground.getBuffer("image/png"),
      monochrome: await monochrome.getBuffer("image/png"),
    };
  }

  private async assetArtwork(bytes: Uint8Array) {
    const input = Buffer.from(bytes);
    const mime = detectImageMimeType(input);
    const message =
      "Android icon.asset must be a decodable PNG or JPEG. Replace the asset and retry.";
    const dimensions = readImageHeaderDimensions(input);
    if ((mime !== "image/png" && mime !== "image/jpeg") || !dimensions) {
      throw new ActionableError(message);
    }
    if (dimensions.width * dimensions.height > MAX_ICON_ASSET_PIXELS) {
      throw new ActionableError(
        `Android icon.asset is ${dimensions.width}x${dimensions.height}; it must be at most ${MAX_ICON_ASSET_PIXELS} pixels (4096x4096). Downscale the image and retry.`,
      );
    }
    let decoded: RawImage;
    try {
      decoded = await this.backend.rawPixels(input);
    } catch (error) {
      throw new ActionableError(message, { cause: error });
    }
    const Jimp = await this.jimpLoader();
    return new Jimp(decoded);
  }

  private async monogram(label: string, background: Rgba) {
    const Jimp = await this.jimpLoader();
    const font = await (this.font ??= loadMonogramFont());
    const initial = segmenter
      .segment(label.trimStart())
      [Symbol.iterator]()
      .next()
      .value?.segment.normalize()
      .toUpperCase();
    // The bundled bitmap font has a limited repertoire. Use one fallback glyph for an
    // unsupported grapheme, even if it contains multiple Unicode code points.
    const text =
      initial && [...initial].every((character) => font.chars[character]) ? initial : "?";
    const glyph = new Jimp({ width: GLYPH_SIZE, height: GLYPH_SIZE });
    glyph.print({ font, x: 8, y: 8, text }).autocrop({ cropOnlyFrames: false });
    const ink = contrastRatio(background, BLACK) >= contrastRatio(background, WHITE) ? 0 : 255;
    glyph.scan((_, __, index) => {
      glyph.bitmap.data.fill(ink, index, index + 3);
    });
    return glyph;
  }
}
