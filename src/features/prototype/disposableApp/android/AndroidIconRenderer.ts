import { pathToFileURL } from "node:url";
import { ActionableError } from "../../../../models/ActionableError";
import type { ImageBackend, RawImage } from "../../../../utils/image/backend/ImageBackend";
import { JimpBackend } from "../../../../utils/image/backend/JimpBackend";
import { loadJimp, type JimpConstructor } from "../../../../utils/image/loadJimp";
import { detectImageMimeType } from "../../../../utils/screenshot/imageHeaderDimensions";
import { contrastRatio, type Rgba } from "../../prototypeContrast";

const CANVAS_SIZE = 432;
const SAFE_SIZE = 288;
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

    const scale = SAFE_SIZE / Math.max(artwork.width, artwork.height);
    artwork.resize({
      w: Math.max(1, Math.round(artwork.width * scale)),
      h: Math.max(1, Math.round(artwork.height * scale)),
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
    if (mime !== "image/png" && mime !== "image/jpeg") {
      throw new ActionableError(message);
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
    const glyph = new Jimp({ width: SAFE_SIZE, height: SAFE_SIZE });
    glyph.print({ font, x: 8, y: 8, text }).autocrop({ cropOnlyFrames: false });
    const ink = contrastRatio(background, BLACK) >= contrastRatio(background, WHITE) ? 0 : 255;
    glyph.scan((_, __, index) => {
      glyph.bitmap.data.fill(ink, index, index + 3);
    });
    return glyph;
  }
}
