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

  constructor(config: VisionFallbackConfig, timer: Timer = defaultTimer, client?: VisionClient) {
    this.config = config;
    this.timer = timer;
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
    searchCriteria: ElementSearchCriteria
  ): Promise<VisionFallbackResult> {
    if (!this.config.enabled) {
      throw new Error("Vision fallback is not enabled");
    }

    // Check cache first
    if (this.config.cacheResults) {
      const cached = this.getCachedResult(screenshotPath, searchCriteria);
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
        hierarchy
      );

      // Check if cost exceeds max
      if (result.costUsd > this.config.maxCostUsd) {
        logger.warn(`Vision fallback cost ($${result.costUsd.toFixed(4)}) exceeds max ($${this.config.maxCostUsd})`);
      }

      logger.debug(`Vision fallback complete: confidence=${result.confidence}, cost=$${result.costUsd.toFixed(4)}, time=${result.durationMs}ms`);

      // Cache result
      if (this.config.cacheResults) {
        this.cacheResult(screenshotPath, searchCriteria, result);
      }

      return result;
    }

    throw new Error(`Unsupported vision provider: ${this.config.provider}`);
  }

  private getCachedResult(
    screenshotPath: string,
    searchCriteria: ElementSearchCriteria
  ): VisionFallbackResult | null {
    const cacheKey = this.generateCacheKey(screenshotPath, searchCriteria);
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

  private cacheResult(
    screenshotPath: string,
    searchCriteria: ElementSearchCriteria,
    result: VisionFallbackResult
  ): void {
    const cacheKey = this.generateCacheKey(screenshotPath, searchCriteria);
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

  private generateCacheKey(
    screenshotPath: string,
    searchCriteria: ElementSearchCriteria
  ): string {
    // Sorted-key serialization: criteria written with their keys in a different
    // order are the same search, and must not cost a second paid analyzer call.
    const criteriaStr = stableStringify(searchCriteria);
    return `${screenshotPath}:${criteriaStr}`;
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
