import type { WcagLevel } from "../../models/AccessibilityAudit";
import type { Element } from "../../models/Element";
import { clamp } from "../../utils/bounds";
import type { RawImage } from "../../utils/image/backend/ImageBackend";
import {
  opaquePixelTable,
  reportedTextSizePx,
  squareHasOpaquePixel,
} from "./contrastImageGeometry";
import type {
  ColorCluster,
  ContrastSample,
  ElementColors,
  GradientDirection,
  GradientInfo,
  RGB,
  RGBA,
} from "./ContrastTypes";

/** Android mdpi baseline: 1dp == 1px at 160 dpi. */
const BASELINE_DENSITY_DPI = 160;
/** WCAG large text (18pt regular, 14pt bold) is about 24dp of text size on Android. */
const LARGE_TEXT_MIN_SIZE_DP = 24;
/**
 * Single-line box height that implies 24dp text: a line box is about 1.33x the font
 * size (Material headlineSmall: 24sp text in a 32dp line). The 24dp *text size* is not
 * the box height; a 24dp box holds 16sp body text (bodyLarge), which is normal text
 * needing 4.5:1 (#10134).
 */
const LARGE_TEXT_MIN_BOX_HEIGHT_DP = 32;
/**
 * Without a reported text size the box height is only a proxy, and only for a box
 * that holds a single line. Two lines of 14sp text need about 40dp, and 48dp is
 * the touch-target size of a button or list row, so a box this tall (or taller) is
 * never taken as proof of large text.
 */
const LARGE_TEXT_BOX_INFERENCE_MAX_HEIGHT_DP = 40;
/** A pixel this far from the background counts as ink. */
const INK_MIN_DISTANCE = 40;
/** A sampled pixel this close to a cluster colour belongs to that cluster's stroke. */
const STROKE_MAX_DISTANCE = 10;
/** A level this close to the background may be an anti-aliasing halo rather than a glyph. */
const HALO_MAX_BACKGROUND_DISTANCE = 40;
/** Grid probes spent locating the ink extent of an element. */
const INK_SCAN_MAX_PROBES = 16384;
/**
 * Grid probes spent looking for a solid stroke of one colour. Every pixel is probed in a
 * box up to this area (a 1000x256 box uses a stride of 2), keeping a failing colour's cost
 * per element bounded.
 */
const STROKE_SCAN_MAX_PROBES = 65536;
/** A connected stroke region filling at most this share of its bounding box is glyph-shaped. */
const GLYPH_MAX_FILL = 0.6;
/** Thin bars (long side at least 3x the short side) of one colour that read as glyph stems. */
const GLYPH_MIN_BARS = 3;
/** Pixels grown across all stroke regions of one colour when judging their shape. */
const GLYPH_SHAPE_MAX_PIXELS = 65536;
/** A sampled "background" this close to the text colour is a glyph pixel, not the background. */
const GLYPH_PIXEL_MAX_DISTANCE = 30;
/** How far from a sample point to look for the colour a stroke away. */
const GLYPH_NEIGHBOUR_OFFSET = 12;
/** Pixel sampling, glyph shape analysis, and WCAG color calculations. */
export class ContrastImageAnalysis {
  constructor(
    private readonly config: { compositeOverlays: boolean },
    private readonly getCachedContrast: (text: RGB, background: RGB) => number,
  ) {}

  /**
   * Read a pixel as RGBA from a decoded raw image, reproducing jimp's
   * `getPixelColor` semantics: coordinates are rounded and edge-extended
   * (clamped to the image bounds) so out-of-range samples return the nearest
   * edge pixel rather than throwing.
   */
  private pixelRGBA(image: RawImage, x: number, y: number): RGBA {
    let xi = Math.round(x);
    let yi = Math.round(y);
    if (xi < 0) {
      xi = 0;
    } else if (xi >= image.width) {
      xi = image.width - 1;
    }
    if (yi < 0) {
      yi = 0;
    } else if (yi >= image.height) {
      yi = image.height - 1;
    }
    const idx = (image.width * yi + xi) * 4;
    return {
      r: image.data[idx],
      g: image.data[idx + 1],
      b: image.data[idx + 2],
      a: image.data[idx + 3],
    };
  }

  /** Quantized clusters retain their actual mean colour; anti-aliasing does not dominate a bin. */
  private colorClusters(colors: RGB[], quantized = true): ColorCluster[] {
    // Numeric RGB keys preserve insertion order (including ties) without string
    // keys, per-bin pixel arrays, or recursively clustering each exact colour.
    const bins = new Map<
      number,
      { r: number; g: number; b: number; count: number; coreCount: number }
    >();
    const exactCounts = new Map<number, number>();
    for (const color of colors) {
      const exactKey = (color.r << 16) | (color.g << 8) | color.b;
      const key = quantized
        ? ((color.r >> 3) << 10) | ((color.g >> 3) << 5) | (color.b >> 3)
        : exactKey;
      const exactCount = (exactCounts.get(exactKey) ?? 0) + 1;
      exactCounts.set(exactKey, exactCount);
      const bin = bins.get(key);
      if (bin) {
        bin.r += color.r;
        bin.g += color.g;
        bin.b += color.b;
        bin.count++;
        bin.coreCount = Math.max(bin.coreCount, exactCount);
      } else {
        bins.set(key, { ...color, count: 1, coreCount: 1 });
      }
    }
    return Array.from(bins.values(), (bin) => ({
      color: {
        r: Math.round(bin.r / bin.count),
        g: Math.round(bin.g / bin.count),
        b: Math.round(bin.b / bin.count),
      },
      count: bin.count,
      coreCount: bin.coreCount,
    })).sort((a, b) => b.count - a.count);
  }

  /** At most 4096 evenly spaced pixels, independent of the element's area. */
  private elementPixels(image: RawImage, bounds: Element["bounds"]): RGB[] {
    const width = Math.ceil(bounds.right) - Math.ceil(bounds.left);
    const height = Math.ceil(bounds.bottom) - Math.ceil(bounds.top);
    const area = width * height;
    const count = Math.min(area, 4096);
    return Array.from({ length: count }, (_, i) => {
      const offset = Math.floor((i * area) / count);
      return this.resolvePixelColor(
        image,
        Math.ceil(bounds.left) + (offset % width),
        Math.ceil(bounds.top) + Math.floor(offset / width),
      );
    });
  }

  /** A dense glyph/block may occupy most of the box; its surrounding perimeter still owns the background. */
  private perimeterPixels(image: RawImage, bounds: Element["bounds"]): RGB[] {
    const colors: RGB[] = [];
    for (let i = 0; i < 128; i++) {
      const x = bounds.left + Math.floor(((bounds.right - bounds.left - 1) * i) / 127);
      const y = bounds.top + Math.floor(((bounds.bottom - bounds.top - 1) * i) / 127);
      colors.push(this.resolvePixelColor(image, x, bounds.top));
      colors.push(this.resolvePixelColor(image, x, bounds.bottom - 1));
      colors.push(this.resolvePixelColor(image, bounds.left, y));
      colors.push(this.resolvePixelColor(image, bounds.right - 1, y));
    }
    return colors;
  }

  /** Ignore the border, while retaining the same bounded interior sampling budget. */
  private interiorBounds(bounds: Element["bounds"]): Element["bounds"] {
    const inset = Math.min(
      4,
      Math.floor((bounds.right - bounds.left - 2) / 2),
      Math.floor((bounds.bottom - bounds.top - 2) / 2),
    );
    return {
      left: bounds.left + inset,
      top: bounds.top + inset,
      right: bounds.right - inset,
      bottom: bounds.bottom - inset,
    };
  }

  /**
   * Bounding box of the pixels that differ from `background`, found on a coarse grid
   * (at most ~16k probes) so a wide, mostly empty box (a hint in a text field) is not
   * sampled uniformly: 4096 evenly spaced samples of a 2000x176px box hit only a handful
   * of glyph pixels, too few to out-vote the background (#10290). Null when the ink
   * covers most of the box (dense foreground; uniform sampling is already right) or
   * nothing differs.
   */
  private inkBounds(
    image: RawImage,
    bounds: Element["bounds"],
    background: RGB,
  ): Element["bounds"] | null {
    const left = Math.ceil(bounds.left);
    const top = Math.ceil(bounds.top);
    const width = Math.ceil(bounds.right) - left;
    const height = Math.ceil(bounds.bottom) - top;
    const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / INK_SCAN_MAX_PROBES)));
    let inkLeft = Infinity;
    let inkTop = Infinity;
    let inkRight = -Infinity;
    let inkBottom = -Infinity;
    let probes = 0;
    let ink = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        probes++;
        if (
          this.colorDistance(this.resolvePixelColor(image, left + x, top + y), background) >
          INK_MIN_DISTANCE
        ) {
          ink++;
          inkLeft = Math.min(inkLeft, x);
          inkTop = Math.min(inkTop, y);
          inkRight = Math.max(inkRight, x);
          inkBottom = Math.max(inkBottom, y);
        }
      }
    }
    if (ink === 0 || ink > probes * 0.5) {
      return null;
    }
    const pad = step + 2;
    const inked = {
      left: left + Math.max(0, inkLeft - pad),
      top: top + Math.max(0, inkTop - pad),
      right: left + Math.min(width, inkRight + pad + 1),
      bottom: top + Math.min(height, inkBottom + pad + 1),
    };
    const smaller = (inked.right - inked.left) * (inked.bottom - inked.top) <= width * height * 0.5;
    return smaller && inked.right - inked.left >= 2 && inked.bottom - inked.top >= 2 ? inked : null;
  }

  /**
   * Whether `color` fills a stroke at least two pixels wide in both directions somewhere
   * in `bounds`: a pixel of that colour whose horizontal and vertical neighbours include
   * the same colour. The anti-aliasing band around a glyph edge is one pixel across, so
   * its levels never qualify, while a glyph or icon of their own colour does.
   */
  private hasSolidStroke(
    image: RawImage,
    bounds: Element["bounds"],
    color: RGB,
    tolerance = STROKE_MAX_DISTANCE,
  ): boolean {
    return !this.solidStrokeSeeds(image, bounds, color, tolerance).next().done;
  }

  /**
   * Pixels of `color` that sit in a stroke at least two pixels wide on both axes, scanned
   * on a 2-D grid whose row and column stride stay equal and small (every pixel up to
   * STROKE_SCAN_MAX_PROBES, then the smallest stride that fits). A stride of `s` finds any
   * stroke at least `s` px wide on both axes; a lattice of evenly spaced offsets instead
   * visits only a few columns of a wide box (16 columns, 62px apart, in a 1000x256 box),
   * so small glyphs between them were never found.
   */
  private *solidStrokeSeeds(
    image: RawImage,
    bounds: Element["bounds"],
    color: RGB,
    tolerance = STROKE_MAX_DISTANCE,
  ): Generator<{ x: number; y: number }> {
    const left = Math.ceil(bounds.left);
    const top = Math.ceil(bounds.top);
    const right = Math.ceil(bounds.right) - 1;
    const bottom = Math.ceil(bounds.bottom) - 1;
    const area = (right - left + 1) * (bottom - top + 1);
    const stride = Math.max(1, Math.ceil(Math.sqrt(area / STROKE_SCAN_MAX_PROBES)));
    const stroke = (x: number, y: number): boolean =>
      this.colorDistance(this.resolvePixelColor(image, x, y), color) <= tolerance;
    const solid = (x: number, y: number): boolean =>
      stroke(x, y) &&
      ((x > left && stroke(x - 1, y)) || (x < right && stroke(x + 1, y))) &&
      ((y > top && stroke(x, y - 1)) || (y < bottom && stroke(x, y + 1)));
    for (let y = top; y <= bottom; y += stride) {
      for (let x = left; x <= right; x += stride) {
        if (solid(x, y)) {
          yield { x, y };
        }
      }
    }
  }

  /**
   * Whether the solid strokes of `color` in `bounds` are shaped like glyphs rather than a
   * filled tonal shape (an avatar, chip, progress track or divider). Each connected region
   * of the colour is measured: text has a region that fills little of its bounding box
   * (a curved or open letter), or several thin bars (stems), while a disc, rectangle or
   * rule is one region that fills most of its box. Region growth is capped at
   * GLYPH_SHAPE_MAX_PIXELS in total, so a large flat fill stops the search early.
   */
  private hasGlyphStrokes(image: RawImage, box: Element["bounds"], color: RGB): boolean {
    // Regions are keyed by raster index, so keep them on the raster.
    const bounds = {
      left: Math.max(0, box.left),
      top: Math.max(0, box.top),
      right: Math.min(image.width, box.right),
      bottom: Math.min(image.height, box.bottom),
    };
    const visited = new Set<number>();
    const budget = { pixels: GLYPH_SHAPE_MAX_PIXELS };
    let bars = 0;
    for (const seed of this.solidStrokeSeeds(image, bounds, color)) {
      if (budget.pixels <= 0 || bars >= GLYPH_MIN_BARS) {
        break;
      }
      if (visited.has(seed.y * image.width + seed.x)) {
        continue;
      }
      const region = this.strokeRegion(image, bounds, color, seed, visited, budget);
      const width = region.right - region.left + 1;
      const height = region.bottom - region.top + 1;
      if (region.count <= width * height * GLYPH_MAX_FILL) {
        return true;
      }
      bars += Math.min(width, height) * 3 <= Math.max(width, height) ? 1 : 0;
    }
    return bars >= GLYPH_MIN_BARS;
  }

  /** The 4-connected region of `color` around `seed` inside `bounds`: its pixel count and extent. */
  private strokeRegion(
    image: RawImage,
    bounds: Element["bounds"],
    color: RGB,
    seed: { x: number; y: number },
    visited: Set<number>,
    budget: { pixels: number },
  ): { count: number; left: number; top: number; right: number; bottom: number } {
    const left = Math.ceil(bounds.left);
    const top = Math.ceil(bounds.top);
    const right = Math.ceil(bounds.right) - 1;
    const bottom = Math.ceil(bounds.bottom) - 1;
    const region = { count: 0, left: seed.x, top: seed.y, right: seed.x, bottom: seed.y };
    const pending = [seed.y * image.width + seed.x];
    visited.add(pending[0]);
    while (pending.length > 0 && budget.pixels > 0) {
      const index = pending.pop()!;
      const x = index % image.width;
      const y = Math.floor(index / image.width);
      budget.pixels--;
      region.count++;
      region.left = Math.min(region.left, x);
      region.top = Math.min(region.top, y);
      region.right = Math.max(region.right, x);
      region.bottom = Math.max(region.bottom, y);
      const neighbours = [
        x > left ? index - 1 : -1,
        x < right ? index + 1 : -1,
        y > top ? index - image.width : -1,
        y < bottom ? index + image.width : -1,
      ];
      for (const next of neighbours) {
        if (next >= 0 && !visited.has(next) && this.isStrokePixel(image, next, color)) {
          visited.add(next);
          pending.push(next);
        }
      }
    }
    return region;
  }

  private isStrokePixel(image: RawImage, index: number, color: RGB): boolean {
    const pixel = this.resolvePixelColor(
      image,
      index % image.width,
      Math.floor(index / image.width),
    );
    return this.colorDistance(pixel, color) <= STROKE_MAX_DISTANCE;
  }

  sampleElementColors(
    image: RawImage,
    bounds: Element["bounds"],
  ): { textColor: RGB; backgroundColor: RGB } {
    const interior = this.interiorBounds(bounds);
    const pixels = this.elementPixels(image, interior);
    const clusters = this.colorClusters(pixels);
    let backgroundColor = clusters[0].color;
    const perimeterPixels = this.perimeterPixels(image, bounds);
    const perimeter = this.colorClusters(perimeterPixels);
    const edgeSupport = perimeter
      .filter((cluster) => this.isSimilarColor(cluster.color, backgroundColor))
      .reduce((sum, cluster) => sum + cluster.count, 0);
    const interiorEdgeSupport = clusters
      .filter(
        (cluster) =>
          !this.isSimilarColor(cluster.color, backgroundColor) &&
          perimeter.some((edge) => this.isSimilarColor(cluster.color, edge.color)),
      )
      .reduce((sum, cluster) => sum + cluster.count, 0);
    // A dense foreground may dominate; edge background must also occur INSIDE
    // the inset box (>=10%) and most of its inset perimeter (>=50%). A border-coloured
    // icon cannot make the outside border replace the element fill.
    const supportedEdges = perimeter.filter((edge) => edge.count >= 512 * 0.1);
    const insetEdgeSupport = this.perimeterPixels(image, this.interiorBounds(bounds)).filter(
      (color) => supportedEdges.some((edge) => this.colorDistance(color, edge.color) <= 40),
    ).length;
    if (
      edgeSupport < 512 * 0.1 &&
      interiorEdgeSupport >= pixels.length * 0.1 &&
      insetEdgeSupport >= 512 * 0.5
    ) {
      backgroundColor = this.averageColor(perimeterPixels);
    }
    // Foreground candidates come from the ink extent when the glyphs are sparse in the box.
    const ink = this.inkBounds(image, interior, backgroundColor);
    const inkPixels = ink ? this.elementPixels(image, ink) : pixels;
    const textClusters = ink ? this.colorClusters(inkPixels) : clusters;
    const supported = textClusters.filter(
      (cluster) =>
        cluster.count >= Math.max(2, inkPixels.length * 0.0025) &&
        !this.isSimilarColor(cluster.color, backgroundColor) &&
        // JPEG ringing around glyphs sits just outside the similarity radius; it is not ink.
        (!ink || this.colorDistance(cluster.color, backgroundColor) > INK_MIN_DISTANCE),
    );
    // A level this close to the background is usually a glyph's anti-aliasing halo, whose
    // neighbouring levels sit within STROKE_MAX_DISTANCE of it and would pass as a stroke of
    // its own colour, pulling the reported text colour toward the background (#14738).
    // Such a level must repeat exactly over a 2x2 block to count as a separate glyph.
    const isSolidStroke = (color: RGB): boolean =>
      this.hasSolidStroke(
        image,
        ink ?? interior,
        color,
        this.colorDistance(color, backgroundColor) <= HALO_MAX_BACKGROUND_DISTANCE
          ? 0
          : STROKE_MAX_DISTANCE,
      );
    const inkText = this.selectTextColor(supported, backgroundColor, perimeter, isSolidStroke);
    // Strokes within INK_MIN_DISTANCE of the background are not ink, so a brighter icon
    // alone can set the extent and leave a faint label beside it unmeasured. Judge faint
    // solid strokes anywhere inside the box as text too, keeping the lower contrast. Only
    // glyph-shaped strokes count: an inset tonal avatar, chip, track or divider in the same
    // distance band is a filled shape, not text.
    const faintText = ink
      ? clusters.filter(
          (cluster) =>
            cluster.count >= Math.max(2, pixels.length * 0.0025) &&
            !this.isSimilarColor(cluster.color, backgroundColor) &&
            this.colorDistance(cluster.color, backgroundColor) <= INK_MIN_DISTANCE &&
            !perimeter.some((edge) => this.isSimilarColor(cluster.color, edge.color)) &&
            this.hasGlyphStrokes(image, interior, cluster.color),
        )
      : [];
    const textColor = faintText.reduce(
      (selected, cluster) =>
        this.getCachedContrast(cluster.color, backgroundColor) <
        this.getCachedContrast(selected, backgroundColor)
          ? cluster.color
          : selected,
      inkText,
    );
    return { textColor, backgroundColor };
  }

  /** Population orders the candidates; when supported core colours are ambiguous,
   * keep the LOWER contrast. An icon cannot displace a smaller supported glyph bin.
   * Keep bins with >=25% of the largest foreground population; smaller bins
   * must have >=80% identical pixels and be absent from the background perimeter.
   * This retains small flat glyphs beside a large icon without retaining fringes.
   * A lossless capture repeats each anti-aliasing level exactly, so a small bin must
   * also form a solid stroke (#10290).
   */
  private selectTextColor(
    clusters: ColorCluster[],
    background: RGB,
    perimeter: ColorCluster[],
    isSolidStroke: (color: RGB) => boolean,
  ): RGB {
    const largest = clusters[0]?.count ?? 0;
    const candidates = clusters.filter(
      (cluster) =>
        cluster.count >= largest * 0.25 ||
        (cluster.coreCount >= cluster.count * 0.8 &&
          !perimeter.some((edge) => this.isSimilarColor(cluster.color, edge.color)) &&
          isSolidStroke(cluster.color)),
    );
    return candidates.reduce((selected, candidate) => {
      const ratio = this.getCachedContrast(candidate.color, background);
      const selectedRatio = this.getCachedContrast(selected, background);
      return ratio < selectedRatio ? candidate.color : selected;
    }, candidates[0]?.color ?? background);
  }

  /**
   * Sample background colors for a set of points
   */
  async sampleBackgroundColors(
    image: RawImage,
    bounds: Element["bounds"],
    elementColors: ElementColors,
    points: Array<{ x: number; y: number }>,
  ): Promise<ContrastSample[]> {
    const samples: ContrastSample[] = [];
    for (const point of points) {
      const backgroundColor = await this.sampleBackgroundAtPoint(
        image,
        bounds,
        elementColors,
        point.x,
        point.y,
      );
      samples.push({
        x: point.x,
        y: point.y,
        ratio: 0,
        backgroundColor,
      });
    }
    return samples;
  }

  private backgroundColorsAtRadius(
    image: RawImage,
    bounds: Element["bounds"],
    textColor: RGB,
    x: number,
    y: number,
    radius: number,
  ): RGB[] {
    const colors: RGB[] = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const sampleX = clamp(x + dx, bounds.left, bounds.right - 1);
        const sampleY = clamp(y + dy, bounds.top, bounds.bottom - 1);
        const color = this.resolvePixelColor(image, sampleX, sampleY);
        if (!this.isSimilarColor(color, textColor)) {
          colors.push(color);
        }
      }
    }
    return colors;
  }

  private async sampleBackgroundAtPoint(
    image: RawImage,
    bounds: Element["bounds"],
    elementColors: ElementColors,
    x: number,
    y: number,
  ): Promise<RGB> {
    const searchRadii = [2, 4, 6, 8];
    for (const radius of searchRadii) {
      const colors = this.backgroundColorsAtRadius(
        image,
        bounds,
        elementColors.textColor,
        x,
        y,
        radius,
      );
      const background = this.colorClusters(colors)[0];
      // A few remaining fringe pixels inside a stroke are not a background.
      // Expand until a locally supported colour is found, then retain its variation.
      if (
        background &&
        colors.length >= (2 * radius + 1) ** 2 * 0.2 &&
        background.count >= colors.length * 0.2
      ) {
        const local = this.colorClusters(
          colors.filter((color) => this.isSimilarColor(color, background.color)),
          false,
        )[0].color;
        return this.isGlyphPixel(image, bounds, elementColors, local, x, y)
          ? elementColors.backgroundColor
          : local;
      }
    }

    return elementColors.backgroundColor;
  }

  /**
   * A point on a glyph stroke yields the stroke itself as its "background" (JPEG ringing
   * and anti-aliasing put it just outside the text colour's similarity radius), which would
   * report ~1:1 for legible text. Treat it as the dominant background instead (#10290).
   */
  private isGlyphPixel(
    image: RawImage,
    bounds: Element["bounds"],
    elementColors: ElementColors,
    color: RGB,
    x: number,
    y: number,
  ): boolean {
    if (
      this.colorDistance(color, elementColors.textColor) > GLYPH_PIXEL_MAX_DISTANCE ||
      this.colorDistance(color, elementColors.textColor) >=
        this.colorDistance(color, elementColors.backgroundColor)
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
      this.isSimilarColor(
        this.resolvePixelColor(
          image,
          clamp(x + dx, bounds.left, bounds.right - 1),
          clamp(y + dy, bounds.top, bounds.bottom - 1),
        ),
        elementColors.backgroundColor,
      ),
    );
    return around.length >= 3;
  }

  private resolvePixelColor(image: RawImage, x: number, y: number): RGB {
    const pixel = this.pixelRGBA(image, x, y);
    if (!this.config.compositeOverlays || pixel.a === 255) {
      return { r: pixel.r, g: pixel.g, b: pixel.b };
    }

    const baseColor = this.findUnderlyingColor(image, x, y);
    if (!baseColor) {
      return { r: pixel.r, g: pixel.g, b: pixel.b };
    }
    return this.compositeColors(baseColor, pixel);
  }

  private underlyingColorAtRadius(
    image: RawImage,
    x: number,
    y: number,
    radius: number,
  ): RGB | null {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        // findUnderlyingColor only asks for the smallest radius whose square holds an opaque
        // pixel, so from radius 2 on no inner sample is opaque: only the ring can answer.
        // Radius 1 still reads its centre, in the original order.
        if (radius > 1 && Math.abs(dx) < radius && Math.abs(dy) < radius) {
          continue;
        }
        // pixelRGBA's addressing (round, then clamp) inlined so the miss path, which runs
        // for hundreds of samples per translucent pixel, reads one alpha byte and allocates
        // nothing. Rounding a value already clamped to [0, size - 1] stays in range.
        const sampleX = Math.round(clamp(x + dx, 0, image.width - 1));
        const sampleY = Math.round(clamp(y + dy, 0, image.height - 1));
        const idx = (image.width * sampleY + sampleX) * 4;
        if (image.data[idx + 3] === 255) {
          return { r: image.data[idx], g: image.data[idx + 1], b: image.data[idx + 2] };
        }
      }
    }
    return null;
  }

  /** Public seam for verifying opaque-pixel search against the reference scan. */
  findUnderlyingColor(image: RawImage, x: number, y: number): RGB | null {
    // The first radius whose square holds an opaque pixel is the one the widening scan stops
    // at; find it from the summed-area table, then scan only that square in the original
    // order so the same pixel wins. A pixel with none within 12 never scans at all.
    const table = opaquePixelTable(image);
    for (let radius = 1; radius <= 12; radius++) {
      if (squareHasOpaquePixel(image, table, x, y, radius)) {
        return this.underlyingColorAtRadius(image, x, y, radius);
      }
    }

    return null;
  }

  private compositeColors(baseColor: RGB, overlay: RGBA): RGB {
    const alpha = overlay.a / 255;
    return {
      r: Math.round(overlay.r * alpha + baseColor.r * (1 - alpha)),
      g: Math.round(overlay.g * alpha + baseColor.g * (1 - alpha)),
      b: Math.round(overlay.b * alpha + baseColor.b * (1 - alpha)),
    };
  }

  detectGradient(samples: ContrastSample[]): GradientInfo | null {
    if (samples.length < 5) {
      return null;
    }

    const colors = samples.map((sample) => sample.backgroundColor);
    const variance = this.calculateColorVariance(colors);
    const gradientThreshold = 250;
    if (variance < gradientThreshold) {
      return null;
    }

    const byAxis = this.calculateGradientAxes(samples);
    const direction = byAxis.direction;
    // A glyph/anti-aliasing outlier amid a uniform background is not a gradient.
    if (this.colorDistance(byAxis.startColor, byAxis.endColor) < 20) {
      return null;
    }
    return {
      isGradient: true,
      direction,
      variance,
      startColor: byAxis.startColor,
      endColor: byAxis.endColor,
    };
  }

  private calculateColorVariance(colors: RGB[]): number {
    const mean = this.averageColor(colors);
    const variance =
      colors.reduce((sum, color) => {
        const dr = color.r - mean.r;
        const dg = color.g - mean.g;
        const db = color.b - mean.b;
        return sum + dr * dr + dg * dg + db * db;
      }, 0) / colors.length;
    return variance / 3;
  }

  private calculateGradientAxes(samples: ContrastSample[]): {
    direction: GradientDirection;
    startColor: RGB;
    endColor: RGB;
  } {
    const sortedByX = [...samples].sort((a, b) => a.x - b.x);
    const sortedByY = [...samples].sort((a, b) => a.y - b.y);
    const left = this.averageColor(sortedByX.slice(0, 3).map((sample) => sample.backgroundColor));
    const right = this.averageColor(sortedByX.slice(-3).map((sample) => sample.backgroundColor));
    const top = this.averageColor(sortedByY.slice(0, 3).map((sample) => sample.backgroundColor));
    const bottom = this.averageColor(sortedByY.slice(-3).map((sample) => sample.backgroundColor));

    const horizontalDelta = this.colorDistance(left, right);
    const verticalDelta = this.colorDistance(top, bottom);

    const minX = sortedByX[0].x;
    const maxX = sortedByX[sortedByX.length - 1].x;
    const minY = sortedByY[0].y;
    const maxY = sortedByY[sortedByY.length - 1].y;

    const topLeft = this.closestSample(samples, minX, minY).backgroundColor;
    const topRight = this.closestSample(samples, maxX, minY).backgroundColor;
    const bottomLeft = this.closestSample(samples, minX, maxY).backgroundColor;
    const bottomRight = this.closestSample(samples, maxX, maxY).backgroundColor;

    const diagonalDownDelta = this.colorDistance(topLeft, bottomRight);
    const diagonalUpDelta = this.colorDistance(topRight, bottomLeft);

    if (
      horizontalDelta >= verticalDelta &&
      horizontalDelta >= diagonalDownDelta &&
      horizontalDelta >= diagonalUpDelta
    ) {
      return { direction: "horizontal", startColor: left, endColor: right };
    }
    if (
      verticalDelta >= horizontalDelta &&
      verticalDelta >= diagonalDownDelta &&
      verticalDelta >= diagonalUpDelta
    ) {
      return { direction: "vertical", startColor: top, endColor: bottom };
    }

    if (diagonalDownDelta >= diagonalUpDelta) {
      return { direction: "diagonal-down", startColor: topLeft, endColor: bottomRight };
    }

    return { direction: "diagonal-up", startColor: bottomLeft, endColor: topRight };
  }

  private closestSample(samples: ContrastSample[], x: number, y: number): ContrastSample {
    let closest = samples[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const sample of samples) {
      const dx = sample.x - x;
      const dy = sample.y - y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        closest = sample;
      }
    }
    return closest;
  }

  getGradientSamplingPoints(
    bounds: Element["bounds"],
    direction: GradientDirection,
  ): Array<{ x: number; y: number }> {
    const { left, top, right, bottom } = bounds;
    const width = right - left;
    const height = bottom - top;
    const inset = Math.max(1, Math.floor(Math.min(width, height) * 0.1));
    const xStart = left + inset;
    const xEnd = right - inset - 1;
    const yStart = top + inset;
    const yEnd = bottom - inset - 1;

    const steps = 5;
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      if (direction === "horizontal") {
        points.push({
          x: Math.round(xStart + t * (xEnd - xStart)),
          y: Math.round((yStart + yEnd) / 2),
        });
      } else if (direction === "vertical") {
        points.push({
          x: Math.round((xStart + xEnd) / 2),
          y: Math.round(yStart + t * (yEnd - yStart)),
        });
      } else if (direction === "diagonal-up") {
        points.push({
          x: Math.round(xStart + t * (xEnd - xStart)),
          y: Math.round(yEnd - t * (yEnd - yStart)),
        });
      } else {
        points.push({
          x: Math.round(xStart + t * (xEnd - xStart)),
          y: Math.round(yStart + t * (yEnd - yStart)),
        });
      }
    }

    return points;
  }

  mergeSamples(baseSamples: ContrastSample[], extraSamples: ContrastSample[]): ContrastSample[] {
    const seen = new Set<string>();
    const merged: ContrastSample[] = [];
    for (const sample of [...baseSamples, ...extraSamples]) {
      const key = `${sample.x},${sample.y}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(sample);
    }
    return merged;
  }

  getSamplingPoints(bounds: Element["bounds"], count: 5 | 9 | 13): Array<{ x: number; y: number }> {
    const { left, top, right, bottom } = bounds;
    const width = right - left;
    const height = bottom - top;
    const inset = Math.max(1, Math.floor(Math.min(width, height) * 0.1));
    const xStart = left + inset;
    const xEnd = right - inset - 1;
    const yStart = top + inset;
    const yEnd = bottom - inset - 1;

    const positions = count === 5 ? [0.5, 0.1, 0.9] : [0.1, 0.5, 0.9];
    const points: Array<{ x: number; y: number }> = [];

    if (count === 5) {
      points.push({
        x: Math.round(xStart + positions[0] * (xEnd - xStart)),
        y: Math.round(yStart + positions[0] * (yEnd - yStart)),
      });
      points.push({
        x: Math.round(xStart),
        y: Math.round(yStart + positions[0] * (yEnd - yStart)),
      });
      points.push({ x: Math.round(xEnd), y: Math.round(yStart + positions[0] * (yEnd - yStart)) });
      points.push({
        x: Math.round(xStart + positions[0] * (xEnd - xStart)),
        y: Math.round(yStart),
      });
      points.push({ x: Math.round(xStart + positions[0] * (xEnd - xStart)), y: Math.round(yEnd) });
      return points;
    }

    for (const xFactor of positions) {
      for (const yFactor of positions) {
        points.push({
          x: Math.round(xStart + xFactor * (xEnd - xStart)),
          y: Math.round(yStart + yFactor * (yEnd - yStart)),
        });
      }
    }

    if (count === 13) {
      points.push({ x: Math.round(xStart), y: Math.round(yStart) });
      points.push({ x: Math.round(xEnd), y: Math.round(yStart) });
      points.push({ x: Math.round(xStart), y: Math.round(yEnd) });
      points.push({ x: Math.round(xEnd), y: Math.round(yEnd) });
    }

    return points;
  }

  detectTextShadow(
    image: RawImage,
    bounds: Element["bounds"],
    textColor: RGB,
    backgroundColor: RGB,
  ): boolean {
    const { left, top, right, bottom } = bounds;
    const inset = 1;
    const samplePoints = [
      { x: left + inset, y: top + inset },
      { x: right - inset - 1, y: top + inset },
      { x: left + inset, y: bottom - inset - 1 },
      { x: right - inset - 1, y: bottom - inset - 1 },
      { x: Math.round((left + right) / 2), y: top + inset },
      { x: Math.round((left + right) / 2), y: bottom - inset - 1 },
      { x: left + inset, y: Math.round((top + bottom) / 2) },
      { x: right - inset - 1, y: Math.round((top + bottom) / 2) },
    ];

    const textLuminance = this.relativeLuminance(textColor);
    const backgroundLuminance = this.relativeLuminance(backgroundColor);
    const textIsLighter = textLuminance > backgroundLuminance;
    const shadowHits = samplePoints.reduce((count, point) => {
      const pixel = this.resolvePixelColor(image, point.x, point.y);
      if (this.isSimilarColor(pixel, textColor)) {
        return count;
      }
      const luminance = this.relativeLuminance(pixel);
      if (textIsLighter && luminance < backgroundLuminance - 0.05) {
        return count + 1;
      }
      if (!textIsLighter && luminance > backgroundLuminance + 0.05) {
        return count + 1;
      }
      return count;
    }, 0);

    return shadowHits >= 3;
  }

  applyShadowAdjustment(
    requiredRatio: number,
    element: Element,
    shadowDetected: boolean,
    density?: number,
  ): number {
    if (!shadowDetected || !this.isLargeText(element, density)) {
      return requiredRatio;
    }

    return Math.max(3.0, requiredRatio - 0.5);
  }

  requiredRatioFor(
    element: Element,
    level: WcagLevel,
    shadowDetected: boolean,
    density?: number,
  ): number {
    return this.applyShadowAdjustment(
      this.getRequiredContrastRatio(element, level, density),
      element,
      shadowDetected,
      density,
    );
  }

  /**
   * WCAG large text is 18pt (14pt bold), about 24dp of text size on Android.
   * Dimensions are physical pixels, so they are converted to dp with the
   * observation's density first (same class as the touch-target fix, #6127). A
   * missing or non-positive density is "unknown": treat the text as normal size
   * (the strict threshold) rather than guessing a density.
   *
   * The capture's `textSize` (px, `AccessibilityNodeInfo` extra rendering info,
   * API 30+) is authoritative when present. Otherwise the box height stands in only
   * for a box that fits a single line (#10039): a 48dp button or a two-line
   * TextView is not evidence of large text, so those get the strict ratio. Bold is
   * not reported, so the 14pt-bold allowance is never granted.
   */
  private isLargeText(element: Element, density?: number): boolean {
    if (!density || density <= 0) {
      return false;
    }
    const textSizePx = reportedTextSizePx(element);
    if (textSizePx !== null) {
      return (textSizePx * BASELINE_DENSITY_DPI) / density >= LARGE_TEXT_MIN_SIZE_DP;
    }
    const heightPx = element.bounds.bottom - element.bounds.top;
    const heightDp = (heightPx * BASELINE_DENSITY_DPI) / density;
    return (
      heightDp >= LARGE_TEXT_MIN_BOX_HEIGHT_DP && heightDp < LARGE_TEXT_BOX_INFERENCE_MAX_HEIGHT_DP
    );
  }

  private isSimilarColor(color: RGB, other: RGB): boolean {
    return this.colorDistance(color, other) <= 20;
  }

  private colorDistance(a: RGB, b: RGB): number {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  /**
   * Calculate average color from array of RGB values
   */
  averageColor(colors: RGB[]): RGB {
    if (colors.length === 0) {
      return { r: 128, g: 128, b: 128 }; // Default to gray
    }

    const sum = colors.reduce(
      (acc, color) => ({
        r: acc.r + color.r,
        g: acc.g + color.g,
        b: acc.b + color.b,
      }),
      { r: 0, g: 0, b: 0 },
    );

    return {
      r: Math.round(sum.r / colors.length),
      g: Math.round(sum.g / colors.length),
      b: Math.round(sum.b / colors.length),
    };
  }

  /**
   * Calculate relative luminance for a color (WCAG formula)
   */
  private relativeLuminance(color: RGB): number {
    const rsRGB = color.r / 255;
    const gsRGB = color.g / 255;
    const bsRGB = color.b / 255;

    const r = rsRGB <= 0.03928 ? rsRGB / 12.92 : Math.pow((rsRGB + 0.055) / 1.055, 2.4);
    const g = gsRGB <= 0.03928 ? gsRGB / 12.92 : Math.pow((gsRGB + 0.055) / 1.055, 2.4);
    const b = bsRGB <= 0.03928 ? bsRGB / 12.92 : Math.pow((bsRGB + 0.055) / 1.055, 2.4);

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * Calculate contrast ratio between two colors (WCAG formula)
   */
  calculateContrastRatio(color1: RGB, color2: RGB): number {
    const lum1 = this.relativeLuminance(color1);
    const lum2 = this.relativeLuminance(color2);

    const lighter = Math.max(lum1, lum2);
    const darker = Math.min(lum1, lum2);

    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Get required contrast ratio for an element based on WCAG level
   */
  getRequiredContrastRatio(element: Element, level: WcagLevel, density?: number): number {
    // Determine if text is large (18pt or 14pt bold)
    // We approximate from the element height converted to dp
    const isLargeText = this.isLargeText(element, density);

    if (level === "AAA") {
      return isLargeText ? 4.5 : 7.0;
    } else if (level === "AA") {
      return isLargeText ? 3.0 : 4.5;
    } else {
      // Level A
      return isLargeText ? 3.0 : 4.5; // Same as AA for contrast
    }
  }
}
