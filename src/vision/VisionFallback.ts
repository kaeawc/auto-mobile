/**
 * Vision Fallback orchestrator for UI element detection
 * Coordinates vision providers (Claude) to find elements when traditional methods fail
 */

import { ClaudeVisionClient } from "./ClaudeVisionClient";
import type {
  VisionFallbackConfig,
  VisionFallbackResult,
  ElementSearchCriteria,
  VisionClient,
} from "./VisionTypes";
import type { ViewHierarchyNode } from "../models/ViewHierarchyResult";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { stableStringify } from "../utils/stableStringify";
import type { ChecksumCalculator } from "../utils/ChecksumCalculator";
import { DefaultChecksumCalculator } from "../utils/ChecksumCalculator";

/**
 * Upper bound on live cache entries. The cache now outlives a single tool call
 * (see VisionFallbackRegistry), so without a cap a long-running daemon would
 * retain one entry per (screenshot, criteria) pair for its whole lifetime.
 * Eviction is oldest-write-first once the cap is reached.
 */
export const MAX_VISION_CACHE_ENTRIES = 64;

export class VisionFallback {
  private config: VisionFallbackConfig;
  private claudeClient: VisionClient | null = null;
  private resultCache: Map<string, { result: VisionFallbackResult; timestamp: number }>;
  private timer: Timer;
  private checksums: ChecksumCalculator;

  constructor(
    config: VisionFallbackConfig,
    timer: Timer = defaultTimer,
    client?: VisionClient,
    checksums: ChecksumCalculator = new DefaultChecksumCalculator(),
  ) {
    this.config = config;
    this.timer = timer;
    this.checksums = checksums;
    this.resultCache = new Map();

    // Initialize Claude client if provider is 'claude'
    if (client) {
      this.claudeClient = client;
    } else if (config.provider === "claude") {
      this.claudeClient = new ClaudeVisionClient();
    }
  }

  async analyzeAndSuggest(
    screenshotPath: string,
    hierarchy: ViewHierarchyNode,
    searchCriteria: ElementSearchCriteria,
  ): Promise<VisionFallbackResult> {
    if (!this.config.enabled) {
      throw new Error("Vision fallback is not enabled");
    }

    // Every capture writes screenshot_<timestamp>.png, so the key must be
    // derived once here from the file's *contents*; see generateCacheKey.
    const cacheKey = this.config.cacheResults
      ? await this.generateCacheKey(screenshotPath, searchCriteria)
      : null;

    // Check cache first
    if (cacheKey) {
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        logger.debug("Vision fallback: using cached result");
        return cached;
      }
    }

    // Use Claude vision
    if (this.config.provider === "claude") {
      if (!this.claudeClient) {
        throw new Error("Claude client not initialized");
      }

      logger.debug("Vision fallback: analyzing with Claude");
      const result = await this.claudeClient.analyzeUIElement(
        screenshotPath,
        searchCriteria,
        hierarchy,
      );

      // Check if cost exceeds max
      if (result.costUsd > this.config.maxCostUsd) {
        logger.warn(
          `Vision fallback cost ($${result.costUsd.toFixed(4)}) exceeds max ($${this.config.maxCostUsd})`,
        );
      }

      logger.debug(
        `Vision fallback complete: confidence=${result.confidence}, cost=$${result.costUsd.toFixed(4)}, time=${result.durationMs}ms`,
      );

      // Cache result
      if (cacheKey) {
        this.cacheResult(cacheKey, result);
      }

      return result;
    }

    throw new Error(`Unsupported vision provider: ${this.config.provider}`);
  }

  private getCachedResult(cacheKey: string): VisionFallbackResult | null {
    const cached = this.resultCache.get(cacheKey);

    if (!cached) {
      return null;
    }

    // Check if cache is still valid
    const now = this.timer.now();
    const ageMinutes = (now - cached.timestamp) / (1000 * 60);

    if (ageMinutes > this.config.cacheTtlMinutes) {
      this.resultCache.delete(cacheKey);
      return null;
    }

    return cached.result;
  }

  private cacheResult(cacheKey: string, result: VisionFallbackResult): void {
    this.evictExpired();
    this.resultCache.set(cacheKey, {
      result,
      timestamp: this.timer.now(),
    });
    this.evictOverflow();
  }

  /**
   * Drop entries past their TTL. getCachedResult only evicts the key it was
   * asked for, so a key that is never queried again would otherwise be
   * retained forever now that the cache is long-lived.
   */
  private evictExpired(): void {
    const now = this.timer.now();
    for (const [key, entry] of this.resultCache) {
      const ageMinutes = (now - entry.timestamp) / (1000 * 60);
      if (ageMinutes > this.config.cacheTtlMinutes) {
        this.resultCache.delete(key);
      }
    }
  }

  /** Map iteration order is insertion order, so this evicts oldest-write-first. */
  private evictOverflow(): void {
    while (this.resultCache.size > MAX_VISION_CACHE_ENTRIES) {
      const oldest = this.resultCache.keys().next();
      if (oldest.done) {
        return;
      }
      this.resultCache.delete(oldest.value);
    }
  }

  private async generateCacheKey(
    screenshotPath: string,
    searchCriteria: ElementSearchCriteria,
  ): Promise<string> {
    // Sorted-key serialization: criteria written with their keys in a different
    // order are the same search, and must not cost a second paid analyzer call.
    const criteriaStr = stableStringify(searchCriteria);
    return `${await this.fingerprintScreenshot(screenshotPath)}:${criteriaStr}`;
  }

  /**
   * Identify a screenshot by its contents, not its path. TakeScreenshot writes
   * screenshot_<timestamp>.png, so a path-keyed cache gets a fresh key on every
   * capture and can never hit — two tool calls against an unchanged screen must
   * produce the same key or the cache is decorative.
   */
  private async fingerprintScreenshot(screenshotPath: string): Promise<string> {
    try {
      const { checksum } = await this.checksums.computeFileSha256(screenshotPath);
      return checksum;
    } catch (error) {
      // Unreadable screenshot: fall back to the path, which is unique per
      // capture. That only costs a cache miss — the paid call still happens
      // and the caller still gets a result, so this must not throw.
      logger.debug(
        `Vision fallback: could not fingerprint ${screenshotPath}, using path as key: ${error}`,
      );
      return screenshotPath;
    }
  }

  /**
   * Clear all cached results
   */
  clearCache(): void {
    this.resultCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.resultCache.size,
      keys: Array.from(this.resultCache.keys()),
    };
  }
}

/**
 * Default vision fallback configuration
 */
export const DEFAULT_VISION_CONFIG: VisionFallbackConfig = {
  enabled: false, // Disabled by default
  provider: "claude",
  confidenceThreshold: "high",
  maxCostUsd: 1.0, // $1 max per call (very conservative)
  cacheResults: true,
  cacheTtlMinutes: 60,
};
