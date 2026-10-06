/**
 * Color contrast checking for WCAG 2.1 compliance
 * Uses screenshot pixel analysis to determine text/background contrast ratios
 * Optimized with multi-level caching for performance
 */

import fs from "fs/promises";
import { Element } from "../../models/Element";
import { WcagLevel } from "../../models/AccessibilityAudit";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { clamp } from "../../utils/bounds";
import type { ImageBackend, RawImage } from "../../utils/image/backend/ImageBackend";
import { resolveImageBackend } from "../../utils/image/backend/resolveImageBackend";

/** Android mdpi baseline: 1dp == 1px at 160 dpi. */
const BASELINE_DENSITY_DPI = 160;
/** WCAG large text (18pt regular, 14pt bold) is about 24dp of text height on Android. */
const LARGE_TEXT_MIN_HEIGHT_DP = 24;
/**
 * Without a reported text size the box height is only a proxy, and only for a box
 * that holds a single line. Two lines of 14sp text need about 40dp, and 48dp is
 * the touch-target size of a button or list row, so a box this tall (or taller) is
 * never taken as proof of large text.
 */
const LARGE_TEXT_BOX_INFERENCE_MAX_HEIGHT_DP = 40;

/** The text size in px the capture reported for this element, or null when absent or unusable. */
function reportedTextSizePx(element: Element): number | null {
  const size: unknown = element.textSize;
  return typeof size === "number" && Number.isFinite(size) && size > 0 ? size : null;
}

/** Whether the whole element rectangle lies inside the decoded image (hierarchy px == raster px on Android). */
function boundsInsideImage(image: RawImage, bounds: Element["bounds"]): boolean {
  return (
    bounds.left >= 0 &&
    bounds.top >= 0 &&
    bounds.right <= image.width &&
    bounds.bottom <= image.height
  );
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface ColorCluster {
  color: RGB;
  count: number;
}

interface RGBA extends RGB {
  a: number;
}

interface ContrastSample {
  x: number;
  y: number;
  ratio: number;
  backgroundColor: RGB;
}

type GradientDirection = "horizontal" | "vertical" | "diagonal-down" | "diagonal-up";

interface GradientInfo {
  isGradient: boolean;
  direction: GradientDirection;
  variance: number;
  startColor: RGB;
  endColor: RGB;
}

interface ContrastResult {
  ratio: number;
  minRatio: number;
  maxRatio: number;
  avgRatio: number;
  samples: ContrastSample[];
  textColor: RGB;
  backgroundColor: RGB;
  gradient?: GradientInfo;
  shadowDetected: boolean;
  baseRequiredRatio: number;
  meetsAA: boolean;
  meetsAAA: boolean;
  requiredRatio: number;
}

/**
 * Configuration options for contrast checking caches
 */
interface ContrastCheckConfig {
  /** Enable multi-point sampling for contrast (default: true) */
  useMultiPointSampling?: boolean;

  /** Detect gradients and sample along gradient direction (default: true) */
  detectGradients?: boolean;

  /** Composite semi-transparent overlays when sampling colors (default: false) */
  compositeOverlays?: boolean;

  /** Detect text shadows and adjust contrast thresholds (default: false) */
  detectTextShadows?: boolean;

  /** Number of sampling points (default: 9) */
  samplingPoints?: 5 | 9 | 13;

  /** Enable screenshot caching (default: true) */
  enableScreenshotCache?: boolean;

  /** Enable color pair caching (default: true) */
  enableColorPairCache?: boolean;

  /** Enable element result caching (default: true) */
  enableElementCache?: boolean;

  /** Enable background color caching (default: true) */
  enableBackgroundCache?: boolean;

  /** Screenshot cache TTL in milliseconds (default: 60000 = 1 minute) */
  screenshotCacheTTL?: number;

  /** Maximum cache sizes */
  maxCacheSize?: {
    screenshots?: number; // Default: 10
    colorPairs?: number; // Default: 1000
    elements?: number; // Default: 500
    backgrounds?: number; // Default: 200
  };
}

/**
 * Cache statistics for debugging and monitoring
 */
interface CacheStats {
  screenshots: {
    size: number;
    hits: number;
    misses: number;
  };
  colorPairs: {
    size: number;
    hits: number;
    misses: number;
  };
  elements: {
    size: number;
    hits: number;
    misses: number;
  };
  backgrounds: {
    size: number;
    hits: number;
    misses: number;
  };
}

interface ContrastCheckerDependencies {
  readFile: (path: string) => Promise<Buffer>;
}

/**
 * Screenshot cache entry
 */
interface ScreenshotCacheEntry {
  image: RawImage;
  timestamp: number;
  fingerprint: string;
}

/**
 * Element result cache entry
 */
interface ElementCacheEntry {
  result: ContrastResult;
  timestamp: number;
  screenshotFingerprint: string;
}

function resolveMaxCacheSize(config: ContrastCheckConfig) {
  return {
    screenshots: config.maxCacheSize?.screenshots ?? 10,
    colorPairs: config.maxCacheSize?.colorPairs ?? 1000,
    elements: config.maxCacheSize?.elements ?? 500,
    backgrounds: config.maxCacheSize?.backgrounds ?? 200,
  };
}

function resolveContrastConfig(config: ContrastCheckConfig) {
  return {
    useMultiPointSampling: config.useMultiPointSampling ?? true,
    detectGradients: config.detectGradients ?? true,
    compositeOverlays: config.compositeOverlays ?? false,
    detectTextShadows: config.detectTextShadows ?? false,
    samplingPoints: config.samplingPoints ?? 9,
    enableScreenshotCache: config.enableScreenshotCache ?? true,
    enableColorPairCache: config.enableColorPairCache ?? true,
    enableElementCache: config.enableElementCache ?? true,
    enableBackgroundCache: config.enableBackgroundCache ?? true,
    screenshotCacheTTL: config.screenshotCacheTTL ?? 60_000,
    maxCacheSize: resolveMaxCacheSize(config),
  };
}

export class ContrastChecker {
  private config: Required<Omit<ContrastCheckConfig, "maxCacheSize">> & {
    maxCacheSize: Required<NonNullable<ContrastCheckConfig["maxCacheSize"]>>;
  };
  private timer: Timer;
  private backend: ImageBackend;

  // Phase 1: Screenshot cache
  private screenshotCache = new Map<string, ScreenshotCacheEntry>();
  private screenshotHits = 0;
  private screenshotMisses = 0;

  // Phase 2: Color pair contrast cache
  private contrastCache = new Map<string, number>();
  private colorPairHits = 0;
  private colorPairMisses = 0;

  // Phase 3: Element result cache
  private elementCache = new Map<string, ElementCacheEntry>();
  private elementHits = 0;
  private elementMisses = 0;

  // Phase 5: Background color cache
  private bgColorCache = new Map<string, RGB>();
  private bgColorHits = 0;
  private bgColorMisses = 0;

  constructor(
    config: ContrastCheckConfig = {},
    timer: Timer = defaultTimer,
    backend: ImageBackend = resolveImageBackend(),
    private readonly deps: ContrastCheckerDependencies = { readFile: fs.readFile },
  ) {
    this.timer = timer;
    this.backend = backend;
    this.config = resolveContrastConfig(config);
  }
  /**
   * Calculate contrast ratio between text element and its background
   * @param screenshotPath Path to the screenshot image
   * @param element The text element to check
   * @param wcagLevel WCAG compliance level (affects minimum ratio)
   * @returns Contrast analysis result
   */
  async checkContrast(
    screenshotPath: string,
    element: Element,
    wcagLevel: WcagLevel,
    density?: number,
  ): Promise<ContrastResult | null> {
    try {
      // Phase 3: Check element-level cache
      if (this.config.enableElementCache) {
        const elementKey = this.elementCacheKey(element, wcagLevel, density);
        const screenshotFingerprint = await this.getScreenshotFingerprint(screenshotPath);
        const cached = this.elementCache.get(elementKey);

        if (cached && cached.screenshotFingerprint === screenshotFingerprint) {
          this.elementHits++;
          return cached.result;
        }
        this.elementMisses++;
      }

      // Extract element bounds
      const { left, top, right, bottom } = element.bounds;
      const width = right - left;
      const height = bottom - top;

      // Skip if element is too small to analyze
      if (width < 2 || height < 2) {
        return null;
      }

      // Phase 1: Get or load screenshot from cache
      const image = await this.getOrLoadScreenshot(screenshotPath);

      // Calculate contrast with the loaded image
      const result = await this.checkContrastWithImage(image, element, wcagLevel, density);

      // Cache the result if element caching is enabled
      if (result && this.config.enableElementCache) {
        const elementKey = this.elementCacheKey(element, wcagLevel, density);
        const screenshotFingerprint = await this.getScreenshotFingerprint(screenshotPath);

        this.elementCache.set(elementKey, {
          result,
          timestamp: this.timer.now(),
          screenshotFingerprint,
        });

        // Cleanup element cache if needed
        this.cleanupCache(this.elementCache, this.config.maxCacheSize.elements);
      }

      return result;
    } catch (error) {
      logger.warn(`Contrast checking error: ${errorMessage(error)}`, error);
      return null;
    }
  }

  private getBatchCachedContrast(
    element: Element,
    wcagLevel: WcagLevel,
    screenshotFingerprint: string,
    density?: number,
  ): ElementCacheEntry | undefined {
    if (!this.config.enableElementCache) {
      return undefined;
    }
    const elementKey = this.elementCacheKey(element, wcagLevel, density);
    const cached = this.elementCache.get(elementKey);
    if (cached && cached.screenshotFingerprint === screenshotFingerprint) {
      this.elementHits++;
      return cached;
    }
    this.elementMisses++;
    return undefined;
  }

  private cacheBatchContrast(
    element: Element,
    wcagLevel: WcagLevel,
    screenshotFingerprint: string,
    result: ContrastResult | null,
    density?: number,
  ): void {
    // Cache the result
    if (result && this.config.enableElementCache) {
      const elementKey = this.elementCacheKey(element, wcagLevel, density);
      this.elementCache.set(elementKey, {
        result,
        timestamp: this.timer.now(),
        screenshotFingerprint,
      });
    }
  }

  /**
   * Phase 4: Batch process multiple elements with a single screenshot load
   * @param screenshotPath Path to the screenshot image
   * @param elements Array of text elements to check
   * @param wcagLevel WCAG compliance level (affects minimum ratio)
   * @param density Display density in DPI; text size is only classified as "large" when known
   * @returns Map of elements to their contrast results
   */
  async checkContrastBatch(
    screenshotPath: string,
    elements: Element[],
    wcagLevel: WcagLevel,
    density?: number,
  ): Promise<Map<Element, ContrastResult | null>> {
    return (await this.checkContrastBatchWithCoverage(screenshotPath, elements, wcagLevel, density))
      .results;
  }

  /**
   * {@link checkContrastBatch} that also reports the elements whose bounds are not entirely
   * inside the decoded screenshot (#10220). Those are never measured: their pixels are not the
   * element's, and the edge-clamped read would invent a colour. They are absent from `results`.
   */
  async checkContrastBatchWithCoverage(
    screenshotPath: string,
    elements: Element[],
    wcagLevel: WcagLevel,
    density?: number,
  ): Promise<{ results: Map<Element, ContrastResult | null>; outsideImage: Element[] }> {
    const results = new Map<Element, ContrastResult | null>();
    const outsideImage: Element[] = [];

    try {
      // Load screenshot once for all elements
      const image = await this.getOrLoadScreenshot(screenshotPath);
      const screenshotFingerprint = await this.getScreenshotFingerprint(screenshotPath);

      for (const element of elements) {
        if (!boundsInsideImage(image, element.bounds)) {
          outsideImage.push(element);
          continue;
        }
        try {
          const cached = this.getBatchCachedContrast(
            element,
            wcagLevel,
            screenshotFingerprint,
            density,
          );
          if (cached) {
            results.set(element, cached.result);
            continue;
          }

          // Calculate contrast for this element
          const result = await this.checkContrastWithImage(image, element, wcagLevel, density);
          results.set(element, result);

          this.cacheBatchContrast(element, wcagLevel, screenshotFingerprint, result, density);
        } catch (error) {
          logger.warn(`Error checking contrast for element: ${errorMessage(error)}`, error);
          results.set(element, null);
        }
      }

      // Cleanup element cache if needed
      if (this.config.enableElementCache) {
        this.cleanupCache(this.elementCache, this.config.maxCacheSize.elements);
      }
    } catch (error) {
      logger.warn(`Batch contrast checking error: ${errorMessage(error)}`, error);
      // Return null for all elements on screenshot load failure
      outsideImage.length = 0;
      for (const element of elements) {
        results.set(element, null);
      }
    }

    return { results, outsideImage };
  }

  /**
   * Calculate contrast with a pre-loaded Jimp image
   */
  private async checkContrastWithImage(
    image: RawImage,
    element: Element,
    wcagLevel: WcagLevel,
    density?: number,
  ): Promise<ContrastResult | null> {
    // Extract element bounds
    const { left, top, right, bottom } = element.bounds;
    const width = right - left;
    const height = bottom - top;

    // Skip if element is too small to analyze
    if (width < 2 || height < 2) {
      return null;
    }

    // Pixels outside the raster are not the element's: never measure an edge-clamped guess.
    if (!boundsInsideImage(image, element.bounds)) {
      return null;
    }

    // Separate glyphs from the dominant background instead of averaging a gap between letters.
    const { textColor, backgroundColor: dominantBackground } = this.sampleElementColors(
      image,
      element.bounds,
    );

    if (!this.config.useMultiPointSampling) {
      const backgroundColor = dominantBackground;
      const ratio = this.getCachedContrast(textColor, backgroundColor);
      const shadowDetected = this.config.detectTextShadows
        ? this.detectTextShadow(image, element.bounds, textColor, backgroundColor)
        : false;
      const baseRequiredRatio = this.getRequiredContrastRatio(element, wcagLevel, density);
      const requiredRatio = this.applyShadowAdjustment(
        baseRequiredRatio,
        element,
        shadowDetected,
        density,
      );
      const meetsAA = ratio >= this.requiredRatioFor(element, "AA", shadowDetected, density);
      const meetsAAA = ratio >= this.requiredRatioFor(element, "AAA", shadowDetected, density);

      return {
        ratio,
        minRatio: ratio,
        maxRatio: ratio,
        avgRatio: ratio,
        samples: [
          {
            x: Math.floor((left + right) / 2),
            y: Math.floor((top + bottom) / 2),
            ratio,
            backgroundColor,
          },
        ],
        textColor,
        backgroundColor,
        shadowDetected,
        baseRequiredRatio,
        meetsAA,
        meetsAAA,
        requiredRatio,
      };
    }

    const samplePoints = this.getSamplingPoints(element.bounds, this.config.samplingPoints);
    const baseSamples = await this.sampleBackgroundColors(
      image,
      element.bounds,
      textColor,
      samplePoints,
    );
    const baseGradient = this.config.detectGradients ? this.detectGradient(baseSamples) : null;

    // Flat backgrounds are judged on the distribution's pair, not a point that missed a glyph.
    let samples = baseSamples.map((sample) => ({ ...sample, backgroundColor: dominantBackground }));
    let gradient: GradientInfo | undefined;
    if (baseGradient?.isGradient) {
      gradient = baseGradient;
      const gradientPoints = this.getGradientSamplingPoints(element.bounds, gradient.direction);
      const gradientSamples = await this.sampleBackgroundColors(
        image,
        element.bounds,
        textColor,
        gradientPoints,
      );
      samples = this.mergeSamples(baseSamples, gradientSamples);
    }

    const sampleRatios = samples.map((sample) => {
      const ratio = this.getCachedContrast(textColor, sample.backgroundColor);
      return { ...sample, ratio };
    });

    const ratios = sampleRatios.map((sample) => sample.ratio);
    const minRatio = Math.min(...ratios);
    const maxRatio = Math.max(...ratios);
    const avgRatio = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
    const backgroundColor = this.averageColor(sampleRatios.map((sample) => sample.backgroundColor));
    this.setBackgroundCache(element.bounds, backgroundColor);

    const shadowDetected = this.config.detectTextShadows
      ? this.detectTextShadow(image, element.bounds, textColor, backgroundColor)
      : false;
    const baseRequiredRatio = this.getRequiredContrastRatio(element, wcagLevel, density);
    const requiredRatio = this.applyShadowAdjustment(
      baseRequiredRatio,
      element,
      shadowDetected,
      density,
    );

    const meetsAA = minRatio >= this.requiredRatioFor(element, "AA", shadowDetected, density);
    const meetsAAA = minRatio >= this.requiredRatioFor(element, "AAA", shadowDetected, density);

    return {
      ratio: minRatio,
      minRatio,
      maxRatio,
      avgRatio,
      samples: sampleRatios,
      textColor,
      backgroundColor,
      gradient,
      shadowDetected,
      baseRequiredRatio,
      meetsAA,
      meetsAAA,
      requiredRatio,
    };
  }

  /**
   * Phase 1: Get or load screenshot from cache
   */
  private async getOrLoadScreenshot(path: string): Promise<RawImage> {
    if (!this.config.enableScreenshotCache) {
      return await this.decodeScreenshot(path);
    }

    const cached = this.screenshotCache.get(path);
    const now = this.timer.now();

    // Check if cache is valid (not expired)
    if (cached && now - cached.timestamp < this.config.screenshotCacheTTL) {
      // Verify the cached image is still valid by checking file fingerprint
      const currentFingerprint = await this.getScreenshotFingerprint(path);
      if (cached.fingerprint === currentFingerprint) {
        this.screenshotHits++;
        return cached.image;
      }
    }

    // Cache miss or expired - load fresh image
    this.screenshotMisses++;
    const image = await this.decodeScreenshot(path);
    const fingerprint = await this.getScreenshotFingerprint(path);

    this.screenshotCache.set(path, {
      image,
      timestamp: now,
      fingerprint,
    });

    // Cleanup screenshot cache if needed
    this.cleanupCache(this.screenshotCache, this.config.maxCacheSize.screenshots);

    return image;
  }

  /**
   * Decode a screenshot file to raw RGBA pixels via the image backend.
   * Replaces the former `Jimp.read(path)`; pixel values are identical (both
   * decode the same PNG), so contrast sampling is byte-for-byte unchanged.
   */
  private async decodeScreenshot(path: string): Promise<RawImage> {
    const buffer = await this.deps.readFile(path);
    return this.backend.rawPixels(buffer);
  }

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

  /**
   * Phase 3: Generate screenshot fingerprint (using mtime for fast checks)
   */
  private async getScreenshotFingerprint(path: string): Promise<string> {
    try {
      const stat = await fs.stat(path);
      return `${path}:${stat.mtime.getTime()}:${stat.size}`;
    } catch (error) {
      logger.warn(
        `Failed to stat contrast screenshot ${path}; using timestamp: ${errorMessage(error)}`,
        error,
      );
      return `${path}:${this.timer.now()}`;
    }
  }

  /**
   * Phase 3: Generate element cache key
   */
  private elementCacheKey(element: Element, wcagLevel: WcagLevel, density?: number): string {
    return JSON.stringify({
      text: element.text,
      bounds: element.bounds,
      class: element.class,
      textSize: reportedTextSizePx(element),
      wcagLevel,
      // The large-text threshold depends on density, so results are density-specific.
      density: density && density > 0 ? density : null,
    });
  }

  /**
   * Phase 2: Get cached contrast ratio or calculate and cache it
   */
  private getCachedContrast(textColor: RGB, bgColor: RGB): number {
    if (!this.config.enableColorPairCache) {
      return this.calculateContrastRatio(textColor, bgColor);
    }

    const key = this.colorPairKey(textColor, bgColor);
    let ratio = this.contrastCache.get(key);

    if (ratio !== undefined) {
      this.colorPairHits++;
      return ratio;
    }

    this.colorPairMisses++;
    ratio = this.calculateContrastRatio(textColor, bgColor);
    this.contrastCache.set(key, ratio);

    // Cleanup color pair cache if needed
    this.cleanupCache(this.contrastCache, this.config.maxCacheSize.colorPairs);

    return ratio;
  }

  /**
   * Phase 2: Generate cache key for color pair (normalized for symmetry)
   */
  private colorPairKey(c1: RGB, c2: RGB): string {
    // Normalize order (contrast is symmetric, so RGB(0,0,0) <-> RGB(255,255,255)
    // should have the same key regardless of order)
    const sum1 = c1.r + c1.g + c1.b;
    const sum2 = c2.r + c2.g + c2.b;
    const [a, b] = sum1 > sum2 ? [c1, c2] : [c2, c1];
    return `${a.r},${a.g},${a.b}:${b.r},${b.g},${b.b}`;
  }

  /**
   * Clear all caches (useful for testing or memory management)
   */
  clearCaches(): void {
    this.screenshotCache.clear();
    this.contrastCache.clear();
    this.elementCache.clear();
    this.bgColorCache.clear();

    // Reset statistics
    this.screenshotHits = 0;
    this.screenshotMisses = 0;
    this.colorPairHits = 0;
    this.colorPairMisses = 0;
    this.elementHits = 0;
    this.elementMisses = 0;
    this.bgColorHits = 0;
    this.bgColorMisses = 0;
  }

  /**
   * Get cache statistics for debugging and monitoring
   */
  getCacheStats(): CacheStats {
    return {
      screenshots: {
        size: this.screenshotCache.size,
        hits: this.screenshotHits,
        misses: this.screenshotMisses,
      },
      colorPairs: {
        size: this.contrastCache.size,
        hits: this.colorPairHits,
        misses: this.colorPairMisses,
      },
      elements: {
        size: this.elementCache.size,
        hits: this.elementHits,
        misses: this.elementMisses,
      },
      backgrounds: {
        size: this.bgColorCache.size,
        hits: this.bgColorHits,
        misses: this.bgColorMisses,
      },
    };
  }

  /**
   * Generic LRU cache cleanup based on timestamp
   */
  private cleanupCache<K, V extends number | { timestamp: number }>(
    cache: Map<K, V>,
    maxSize: number,
  ): void {
    if (cache.size <= maxSize) {
      return;
    }

    // Convert to array and sort by timestamp (oldest first)
    const entries = Array.from(cache.entries()).sort((a, b) => {
      // Numeric contrast ratios have no timestamp; preserve insertion-order eviction.
      if (typeof a[1] === "number" || typeof b[1] === "number") {
        return 0;
      }
      return a[1].timestamp - b[1].timestamp;
    });

    // Remove oldest entries until we're at maxSize
    const toRemove = cache.size - maxSize;
    for (let i = 0; i < toRemove; i++) {
      cache.delete(entries[i][0]);
    }
  }

  /** Quantized clusters retain their actual mean colour; anti-aliasing does not dominate a bin. */
  private colorClusters(colors: RGB[]): ColorCluster[] {
    const bins = new Map<string, RGB[]>();
    for (const color of colors) {
      const key = `${color.r >> 3},${color.g >> 3},${color.b >> 3}`;
      const bin = bins.get(key);
      if (bin) {
        bin.push(color);
      } else {
        bins.set(key, [color]);
      }
    }
    return Array.from(bins.values(), (bin) => ({
      color: this.averageColor(bin),
      count: bin.length,
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

  private sampleElementColors(
    image: RawImage,
    bounds: Element["bounds"],
  ): {
    textColor: RGB;
    backgroundColor: RGB;
  } {
    const pixels = this.elementPixels(image, bounds);
    const clusters = this.colorClusters(pixels);
    const backgroundColor = clusters[0].color;
    const perimeter = this.perimeterPixels(image, bounds);
    // Only override a dominant interior block when it is absent from the surrounding edge.
    const edgeSupport = perimeter.filter((color) =>
      this.isSimilarColor(color, backgroundColor),
    ).length;
    if (edgeSupport < perimeter.length * 0.1) {
      const surrounding = this.perimeterPixels(image, {
        left: bounds.left - 2,
        top: bounds.top - 2,
        right: bounds.right + 2,
        bottom: bounds.bottom + 2,
      });
      return {
        textColor: backgroundColor,
        backgroundColor: this.colorClusters(surrounding)[0].color,
      };
    }
    const supported = clusters.filter(
      (cluster) => cluster.count >= Math.max(2, pixels.length * 0.001),
    );
    const text = supported.reduce(
      (farthest, cluster) =>
        this.colorDistance(cluster.color, backgroundColor) >
        this.colorDistance(farthest.color, backgroundColor)
          ? cluster
          : farthest,
      clusters[0],
    );
    return { textColor: text.color, backgroundColor };
  }

  /**
   * Sample background colors for a set of points
   */
  private async sampleBackgroundColors(
    image: RawImage,
    bounds: Element["bounds"],
    textColor: RGB,
    points: Array<{ x: number; y: number }>,
  ): Promise<ContrastSample[]> {
    const samples: ContrastSample[] = [];
    for (const point of points) {
      const backgroundColor = await this.sampleBackgroundAtPoint(
        image,
        bounds,
        textColor,
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
    textColor: RGB,
    x: number,
    y: number,
  ): Promise<RGB> {
    const searchRadii = [2, 4, 6, 8];
    for (const radius of searchRadii) {
      const colors = this.backgroundColorsAtRadius(image, bounds, textColor, x, y, radius);
      if (colors.length > 0) {
        return this.colorClusters(colors)[0].color;
      }
    }

    if (this.config.enableBackgroundCache) {
      const cached = this.getBackgroundCache(bounds);
      if (cached) {
        return cached;
      }
    }

    return await this.sampleBackgroundEdgeColor(image, bounds);
  }

  private async sampleBackgroundEdgeColor(
    image: RawImage,
    bounds: Element["bounds"],
  ): Promise<RGB> {
    const cached = this.config.enableBackgroundCache ? this.getBackgroundCache(bounds) : null;
    if (cached) {
      return cached;
    }

    const { left, top, right, bottom } = bounds;
    const colors: RGB[] = [];
    const edgeSampleSize = 2;

    for (let x = left; x < right; x += 3) {
      for (let y = top; y < top + edgeSampleSize; y++) {
        colors.push(this.resolvePixelColor(image, x, y));
      }
      for (let y = bottom - edgeSampleSize; y < bottom; y++) {
        colors.push(this.resolvePixelColor(image, x, y));
      }
    }

    for (let y = top; y < bottom; y += 3) {
      for (let x = left; x < left + edgeSampleSize; x++) {
        colors.push(this.resolvePixelColor(image, x, y));
      }
      for (let x = right - edgeSampleSize; x < right; x++) {
        colors.push(this.resolvePixelColor(image, x, y));
      }
    }

    if (colors.length === 0) {
      const margin = 5;
      for (let x = Math.max(0, left - margin); x < left; x++) {
        for (let y = top; y < bottom; y += 3) {
          colors.push(this.resolvePixelColor(image, x, y));
        }
      }
    }

    const color = this.averageColor(colors);
    this.setBackgroundCache(bounds, color);
    return color;
  }

  private getBackgroundCache(bounds: Element["bounds"]): RGB | null {
    const key = `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`;
    const cached = this.bgColorCache.get(key);
    if (cached) {
      this.bgColorHits++;
      return cached;
    }
    this.bgColorMisses++;
    return null;
  }

  private setBackgroundCache(bounds: Element["bounds"], color: RGB): void {
    if (!this.config.enableBackgroundCache) {
      return;
    }
    const key = `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`;
    this.bgColorCache.set(key, color);
    if (this.bgColorCache.size > this.config.maxCacheSize.backgrounds) {
      const firstKey = this.bgColorCache.keys().next().value;
      if (firstKey) {
        this.bgColorCache.delete(firstKey);
      }
    }
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
        const sampleX = clamp(x + dx, 0, image.width - 1);
        const sampleY = clamp(y + dy, 0, image.height - 1);
        const pixel = this.pixelRGBA(image, sampleX, sampleY);
        if (pixel.a === 255) {
          return { r: pixel.r, g: pixel.g, b: pixel.b };
        }
      }
    }
    return null;
  }

  private findUnderlyingColor(image: RawImage, x: number, y: number): RGB | null {
    for (let radius = 1; radius <= 12; radius++) {
      const color = this.underlyingColorAtRadius(image, x, y, radius);
      if (color) {
        return color;
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

  private detectGradient(samples: ContrastSample[]): GradientInfo | null {
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

  private getGradientSamplingPoints(
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

  private mergeSamples(
    baseSamples: ContrastSample[],
    extraSamples: ContrastSample[],
  ): ContrastSample[] {
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

  private getSamplingPoints(
    bounds: Element["bounds"],
    count: 5 | 9 | 13,
  ): Array<{ x: number; y: number }> {
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

  private detectTextShadow(
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

  private applyShadowAdjustment(
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

  private requiredRatioFor(
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
      return (textSizePx * BASELINE_DENSITY_DPI) / density >= LARGE_TEXT_MIN_HEIGHT_DP;
    }
    const heightPx = element.bounds.bottom - element.bounds.top;
    const heightDp = (heightPx * BASELINE_DENSITY_DPI) / density;
    return (
      heightDp >= LARGE_TEXT_MIN_HEIGHT_DP && heightDp < LARGE_TEXT_BOX_INFERENCE_MAX_HEIGHT_DP
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
  private averageColor(colors: RGB[]): RGB {
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
  private calculateContrastRatio(color1: RGB, color2: RGB): number {
    const lum1 = this.relativeLuminance(color1);
    const lum2 = this.relativeLuminance(color2);

    const lighter = Math.max(lum1, lum2);
    const darker = Math.min(lum1, lum2);

    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Get required contrast ratio for an element based on WCAG level
   */
  private getRequiredContrastRatio(element: Element, level: WcagLevel, density?: number): number {
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
