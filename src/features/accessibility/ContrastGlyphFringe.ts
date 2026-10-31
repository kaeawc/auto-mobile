import type { Element } from "../../models/Element";
import type { RawImage } from "../../utils/image/backend/ImageBackend";
import { clamp } from "../../utils/bounds";
import type { ElementColors, RGB } from "./ContrastTypes";

/** How far a level may sit off the text/background segment and still be their blend. */
const BLEND_MAX_RESIDUAL = 6;
/** A neighbour must be this much nearer the text colour than a level to make it a fringe. */
const FRINGE_MIN_INK_GAIN = 20;
/** A pixel this close to a level's average colour belongs to the level. */
const LEVEL_MAX_DISTANCE = 2;
/** A neighbour must be this much nearer the page colour than a level to be on its pale side. */
const FRINGE_MIN_PALE_GAIN = 10;
/** Half-size of the window around a sample point searched for a fringe level. */
const SAMPLE_WINDOW = 8;
/** Pixels of one level inspected when deciding whether it is a fringe. */
const FRINGE_MAX_PIXELS = 256;
/** Share of a fringe level's pixels that must sit beside inkier pixels. */
const FRINGE_MIN_SHARE = 0.5;

/** A sampled "background" this close to the text colour is a glyph pixel, not the background. */
const GLYPH_PIXEL_MAX_DISTANCE = 30;
/** How far from a sample point to look for the colour a stroke away. */
const GLYPH_NEIGHBOUR_OFFSET = 12;

function isSimilarColor(color: RGB, other: RGB): boolean {
  return colorDistance(color, other) <= 20;
}

function colorDistance(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Tells a glyph's anti-aliasing fringe apart from a second, fainter glyph colour (#14738). A
 * lossless capture repeats each fringe level exactly along a stem, so a stroke test alone
 * accepts it as text and reports the pale fringe as the text colour.
 */
export class ContrastGlyphFringe {
  constructor(private readonly resolve: (image: RawImage, x: number, y: number) => RGB) {}

  /**
   * A point on a glyph stroke yields the stroke itself as its "background" (JPEG ringing
   * and anti-aliasing put it just outside the text colour's similarity radius), which would
   * report ~1:1 for legible text. Treat it as the dominant background instead (#10290).
   */
  isGlyphPixel(
    image: RawImage,
    bounds: Element["bounds"],
    elementColors: ElementColors,
    { color, point }: { color: RGB; point: { x: number; y: number } },
  ): boolean {
    const { x, y } = point;
    const nearText = colorDistance(color, elementColors.textColor) <= GLYPH_PIXEL_MAX_DISTANCE;
    // The levels around a thin stem are anti-aliasing fringes of the text, and a point on the
    // stem sees little else once the text colour itself is excluded. The stem is too wide to
    // see the page one neighbour offset away, so the point itself being glyph ink decides
    // (#14738). A wide region of the same level is a real background, never a fringe.
    if (
      !nearText &&
      isSimilarColor(this.resolve(image, x, y), elementColors.textColor) &&
      this.isFringeNear(image, bounds, point, { color, ...elementColors })
    ) {
      return true;
    }
    if (
      !nearText ||
      colorDistance(color, elementColors.textColor) >=
        colorDistance(color, elementColors.backgroundColor)
    ) {
      return false;
    }
    // A stroke is narrow: the colour a few strokes away is the dominant background. A
    // genuinely text-coloured region (a gradient end, an image) is not surrounded by it.
    const around = [
      [GLYPH_NEIGHBOUR_OFFSET, 0],
      [-GLYPH_NEIGHBOUR_OFFSET, 0],
      [0, GLYPH_NEIGHBOUR_OFFSET],
      [0, -GLYPH_NEIGHBOUR_OFFSET],
    ].filter(([dx, dy]) =>
      isSimilarColor(
        this.resolve(
          image,
          clamp(x + dx, bounds.left, bounds.right - 1),
          clamp(y + dy, bounds.top, bounds.bottom - 1),
        ),
        elementColors.backgroundColor,
      ),
    );
    return around.length >= 3;
  }

  /** Whether the level `color` is a fringe of `text` within a window around a sample point. */
  private isFringeNear(
    image: RawImage,
    bounds: Element["bounds"],
    point: { x: number; y: number },
    { color, textColor: text, backgroundColor: background }: ElementColors & { color: RGB },
  ): boolean {
    return this.isFringe(
      image,
      {
        left: Math.max(bounds.left, point.x - SAMPLE_WINDOW),
        top: Math.max(bounds.top, point.y - SAMPLE_WINDOW),
        right: Math.min(bounds.right, point.x + SAMPLE_WINDOW),
        bottom: Math.min(bounds.bottom, point.y + SAMPLE_WINDOW),
      },
      color,
      { text, background },
    );
  }

  /** Pixels of one anti-aliasing level, thin lines included (a stem edge is one pixel wide). */
  private *levelPixels(
    image: RawImage,
    bounds: Element["bounds"],
    color: RGB,
  ): Generator<{ x: number; y: number }> {
    const left = Math.ceil(bounds.left);
    const top = Math.ceil(bounds.top);
    const right = Math.ceil(bounds.right) - 1;
    const bottom = Math.ceil(bounds.bottom) - 1;
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        if (colorDistance(this.resolve(image, x, y), color) <= LEVEL_MAX_DISTANCE) {
          yield { x, y };
        }
      }
    }
  }

  /**
   * Whether `color` is the anti-aliasing fringe of the `text` colour rather than a glyph colour
   * of its own: a blend of the text over the background that sits right beside inkier pixels.
   * A separate faint glyph is flanked by background instead (#14738).
   */
  isFringe(
    image: RawImage,
    bounds: Element["bounds"],
    color: RGB,
    { text, background }: { text: RGB; background: RGB },
  ): boolean {
    if (!this.isAntiAliasingBlend(color, background, text)) {
      return false;
    }
    const own = colorDistance(color, text);
    const ownFromBackground = colorDistance(color, background);
    const at = (x: number, y: number): RGB | null =>
      x >= 0 && y >= 0 && x < image.width && y < image.height ? this.resolve(image, x, y) : null;
    const inker = (pixel: RGB | null): boolean =>
      pixel !== null && colorDistance(pixel, text) < own - FRINGE_MIN_INK_GAIN;
    const paler = (pixel: RGB | null): boolean =>
      pixel !== null && colorDistance(pixel, background) < ownFromBackground - FRINGE_MIN_PALE_GAIN;
    // A fringe is a step between ink and page: inker on one side, paler on the other. A flat
    // region of the same level (a gradient end beside a glyph) has no paler side.
    const step = (x: number, y: number, dx: number, dy: number): boolean =>
      [1, 2, 3].some((d) => inker(at(x + dx * d, y + dy * d))) &&
      [1, 2, 3].some((d) => paler(at(x - dx * d, y - dy * d)));
    let seen = 0;
    let beside = 0;
    for (const pixel of this.levelPixels(image, bounds, color)) {
      seen++;
      if (
        step(pixel.x, pixel.y, 1, 0) ||
        step(pixel.x, pixel.y, -1, 0) ||
        step(pixel.x, pixel.y, 0, 1) ||
        step(pixel.x, pixel.y, 0, -1)
      ) {
        beside++;
      }
      if (seen >= FRINGE_MAX_PIXELS) {
        break;
      }
    }
    return seen > 0 && beside >= seen * FRINGE_MIN_SHARE;
  }

  /**
   * A glyph edge is coverage-weighted: each anti-aliasing level is a linear blend of the
   * text colour over the background, so it lies on the segment between them. A lossless
   * capture repeats such a level exactly along a stem, which a stroke test cannot tell from a
   * second, fainter glyph colour (#14738).
   */
  private isAntiAliasingBlend(color: RGB, background: RGB, text: RGB): boolean {
    const dr = text.r - background.r;
    const dg = text.g - background.g;
    const db = text.b - background.b;
    const span = dr * dr + dg * dg + db * db;
    if (span === 0) {
      return false;
    }
    const t =
      ((color.r - background.r) * dr +
        (color.g - background.g) * dg +
        (color.b - background.b) * db) /
      span;
    if (t <= 0 || t >= 1) {
      return false;
    }
    const nearest = {
      r: background.r + t * dr,
      g: background.g + t * dg,
      b: background.b + t * db,
    };
    return colorDistance(color, nearest) <= BLEND_MAX_RESIDUAL;
  }
}
