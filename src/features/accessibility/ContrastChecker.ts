/**
 * Color contrast checking for WCAG 2.1 compliance
 * Uses screenshot pixel analysis to determine text/background contrast ratios
 * Optimized with multi-level caching for performance
 */

import { ContrastImageAnalysis } from "./ContrastImageAnalysis";
import type {
  CacheStats,
  ContrastCheckConfig,
  ContrastResult,
  GradientInfo,
  RGB,
} from "./ContrastTypes";
import fs from "fs/promises";
import { WcagLevel } from "../../models/AccessibilityAudit";
import { Element } from "../../models/Element";
import { errorMessage } from "../../utils/describeUnknownError";
import type { ImageBackend, RawImage } from "../../utils/image/backend/ImageBackend";
import { resolveImageBackend } from "../../utils/image/backend/resolveImageBackend";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { boundsInsideImage, reportedTextSizePx } from "./contrastImageGeometry";

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
  private readonly imageAnalysis: ContrastImageAnalysis;
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
    this.imageAnalysis = new ContrastImageAnalysis(this.config, (text, background) =>
      this.getCachedContrast(text, background),
    );
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
        results.set(
          element,
          await this.checkBatchElement(image, element, wcagLevel, screenshotFingerprint, density),
        );
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

  /** One element of a batch check: served from the batch cache when possible, null on failure. */
  private async checkBatchElement(
    image: RawImage,
    element: Element,
    wcagLevel: WcagLevel,
    screenshotFingerprint: string,
    density?: number,
  ): Promise<ContrastResult | null> {
    try {
      const cached = this.getBatchCachedContrast(
        element,
        wcagLevel,
        screenshotFingerprint,
        density,
      );
      if (cached) {
        return cached.result;
      }
      const result = await this.checkContrastWithImage(image, element, wcagLevel, density);
      this.cacheBatchContrast(element, wcagLevel, screenshotFingerprint, result, density);
      return result;
    } catch (error) {
      logger.warn(`Error checking contrast for element: ${errorMessage(error)}`, error);
      return null;
    }
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
    const { textColor, backgroundColor: dominantBackground } =
      this.imageAnalysis.sampleElementColors(image, element.bounds);

    if (!this.config.useMultiPointSampling) {
      const backgroundColor = dominantBackground;
      const ratio = this.getCachedContrast(textColor, backgroundColor);
      const shadowDetected = this.config.detectTextShadows
        ? this.imageAnalysis.detectTextShadow(image, element.bounds, textColor, backgroundColor)
        : false;
      const baseRequiredRatio = this.imageAnalysis.getRequiredContrastRatio(
        element,
        wcagLevel,
        density,
      );
      const requiredRatio = this.imageAnalysis.applyShadowAdjustment(
        baseRequiredRatio,
        element,
        shadowDetected,
        density,
      );
      const meetsAA =
        ratio >= this.imageAnalysis.requiredRatioFor(element, "AA", shadowDetected, density);
      const meetsAAA =
        ratio >= this.imageAnalysis.requiredRatioFor(element, "AAA", shadowDetected, density);

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

    const samplePoints = this.imageAnalysis.getSamplingPoints(
      element.bounds,
      this.config.samplingPoints,
    );
    const baseSamples = await this.imageAnalysis.sampleBackgroundColors(
      image,
      element.bounds,
      { textColor, backgroundColor: dominantBackground },
      samplePoints,
    );
    const baseGradient = this.config.detectGradients
      ? this.imageAnalysis.detectGradient(baseSamples)
      : null;

    // Preserve local backgrounds even when their variation has no linear gradient axis.
    let samples = baseSamples;
    let gradient: GradientInfo | undefined;
    if (baseGradient?.isGradient) {
      gradient = baseGradient;
      const gradientPoints = this.imageAnalysis.getGradientSamplingPoints(
        element.bounds,
        gradient.direction,
      );
      const gradientSamples = await this.imageAnalysis.sampleBackgroundColors(
        image,
        element.bounds,
        { textColor, backgroundColor: dominantBackground },
        gradientPoints,
      );
      samples = this.imageAnalysis.mergeSamples(baseSamples, gradientSamples);
    }

    const sampleRatios = samples.map((sample) => {
      const ratio = this.getCachedContrast(textColor, sample.backgroundColor);
      return { ...sample, ratio };
    });

    const ratios = sampleRatios.map((sample) => sample.ratio);
    const minRatio = Math.min(...ratios);
    const maxRatio = Math.max(...ratios);
    const avgRatio = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
    const backgroundColor = this.imageAnalysis.averageColor(
      sampleRatios.map((sample) => sample.backgroundColor),
    );
    this.setBackgroundCache(element.bounds, backgroundColor);

    const shadowDetected = this.config.detectTextShadows
      ? this.imageAnalysis.detectTextShadow(image, element.bounds, textColor, backgroundColor)
      : false;
    const baseRequiredRatio = this.imageAnalysis.getRequiredContrastRatio(
      element,
      wcagLevel,
      density,
    );
    const requiredRatio = this.imageAnalysis.applyShadowAdjustment(
      baseRequiredRatio,
      element,
      shadowDetected,
      density,
    );

    const meetsAA =
      minRatio >= this.imageAnalysis.requiredRatioFor(element, "AA", shadowDetected, density);
    const meetsAAA =
      minRatio >= this.imageAnalysis.requiredRatioFor(element, "AAA", shadowDetected, density);

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
      return this.imageAnalysis.calculateContrastRatio(textColor, bgColor);
    }

    const key = this.colorPairKey(textColor, bgColor);
    let ratio = this.contrastCache.get(key);

    if (ratio !== undefined) {
      this.colorPairHits++;
      return ratio;
    }

    this.colorPairMisses++;
    ratio = this.imageAnalysis.calculateContrastRatio(textColor, bgColor);
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
}
