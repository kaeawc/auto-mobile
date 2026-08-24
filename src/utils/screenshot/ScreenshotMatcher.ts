import { promises as fsPromises } from "node:fs";
import path from "path";
import { logger } from "../logger";
import { readFileAsync } from "../io";
import { DEFAULT_FUZZY_MATCH_TOLERANCE_PERCENT } from "../constants";
import { ScreenshotComparator } from "./ScreenshotComparator";
import { PerceptualHasher } from "./PerceptualHasher";
import { ScreenshotCache } from "./ScreenshotCache";
import { Timer, defaultTimer } from "../SystemTimer";

export interface SimilarScreenshotResult {
  filePath: string;
  similarity: number;
  matchFound: boolean;
}

/**
 * Select the `k` items with the largest `value`, returned in descending order,
 * without fully sorting the input. Effectively O(n) for the common case (most
 * items rejected by a single comparison against the current k-th largest) and
 * O(n * k) worst case, versus O(n log n) for a full sort when only k << n items
 * are needed (issue #3433).
 *
 * Ties preserve input order, matching a stable descending sort followed by
 * `slice(0, k)`.
 */
export function topKByDescending<T>(items: T[], k: number, value: (item: T) => number): T[] {
  if (k <= 0) {
    return [];
  }

  // `top` is kept sorted by value, descending, with at most k entries.
  const top: Array<{ item: T; value: number }> = [];
  for (const item of items) {
    const itemValue = value(item);
    if (top.length >= k && itemValue <= top[top.length - 1].value) {
      continue; // not large enough to enter the current top-k
    }

    // Binary search for the insertion point; `>=` skips past equal values so a
    // new item lands after existing equals (stable ordering).
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (top[mid].value >= itemValue) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    top.splice(lo, 0, { item, value: itemValue });
    if (top.length > k) {
      top.pop();
    }
  }

  return top.map((entry) => entry.item);
}

/**
 * Assemble the final per-path results of the two-stage batch comparison:
 * precise pixel results for candidates, falling back to the stage-1 perceptual
 * similarity for everything else.
 *
 * The two result arrays are indexed by file path once (O(n)) instead of running
 * a linear `.find()` per screenshot path, which made stitching O(n^2) in the
 * number of cached screenshots (issue #3430).
 */
export function stitchBatchResults(
  screenshotPaths: string[],
  preciseResults: SimilarScreenshotResult[],
  stage1Results: Array<{ filePath: string; perceptualSimilarity: number } | null>,
): SimilarScreenshotResult[] {
  const preciseByPath = new Map(preciseResults.map((result) => [result.filePath, result]));
  const stage1ByPath = new Map<string, number>();
  for (const result of stage1Results) {
    if (result) {
      stage1ByPath.set(result.filePath, result.perceptualSimilarity);
    }
  }

  return screenshotPaths.map((filePath) => {
    const preciseResult = preciseByPath.get(filePath);
    if (preciseResult) {
      return preciseResult;
    }

    // For non-candidates, use perceptual similarity as approximate result
    return {
      filePath,
      similarity: stage1ByPath.get(filePath) || 0,
      matchFound: false,
    };
  });
}

export class ScreenshotMatcher {
  /**
   * Batch compare multiple screenshots in parallel for better performance
   * @param targetBuffer Target screenshot buffer to compare against
   * @param screenshotPaths Array of screenshot file paths to compare
   * @param tolerancePercent Similarity tolerance percentage (e.g., 0.2 for 0.2%)
   * @param fastMode Enable fast mode for bulk comparisons
   * @returns Promise with array of comparison results
   */
  static async batchCompareScreenshots(
    targetBuffer: Buffer,
    screenshotPaths: string[],
    tolerancePercent: number = DEFAULT_FUZZY_MATCH_TOLERANCE_PERCENT,
    fastMode: boolean = true,
    timer: Timer = defaultTimer,
  ): Promise<Array<{ filePath: string; similarity: number; matchFound: boolean }>> {
    const batchStart = timer.now();
    const minSimilarity = 100 - tolerancePercent;

    logger.info(
      `Starting batch comparison of ${screenshotPaths.length} screenshots (fast mode: ${fastMode})`,
    );

    try {
      const comparisonPromises = screenshotPaths.map(async (filePath) => {
        try {
          const cachedBuffer = await readFileAsync(filePath);
          const comparisonResult = await ScreenshotComparator.compareImages(
            targetBuffer,
            cachedBuffer,
            0.1,
            fastMode,
          );

          return {
            filePath,
            similarity: comparisonResult.similarity,
            matchFound: comparisonResult.similarity >= minSimilarity,
          };
        } catch (error) {
          logger.debug(`Failed to compare ${path.basename(filePath)}: ${(error as Error).message}`);
          return {
            filePath,
            similarity: 0,
            matchFound: false,
          };
        }
      });

      const results = await Promise.all(comparisonPromises);
      const batchTime = timer.now() - batchStart;

      const matches = results.filter((r) => r.matchFound);
      logger.info(
        `Batch comparison completed in ${batchTime}ms: ${matches.length}/${results.length} matches found`,
      );

      return results;
    } catch (error) {
      const batchTime = timer.now() - batchStart;
      logger.warn(`Batch comparison failed after ${batchTime}ms: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Two-stage batch comparison: fast perceptual hash filtering + precise pixel comparison
   * @param targetBuffer Target screenshot buffer to compare against
   * @param screenshotPaths Array of screenshot file paths to compare
   * @param tolerancePercent Similarity tolerance percentage (e.g., 0.2 for 0.2%)
   * @param fastMode Enable fast mode for bulk comparisons
   * @returns Promise with array of comparison results
   */
  static async optimizedBatchCompareScreenshots(
    targetBuffer: Buffer,
    screenshotPaths: string[],
    tolerancePercent: number = DEFAULT_FUZZY_MATCH_TOLERANCE_PERCENT,
    fastMode: boolean = true,
    timer: Timer = defaultTimer,
  ): Promise<Array<{ filePath: string; similarity: number; matchFound: boolean }>> {
    const batchStart = timer.now();
    const minSimilarity = 100 - tolerancePercent;

    logger.info(
      `Starting optimized two-stage batch comparison of ${screenshotPaths.length} screenshots`,
    );

    try {
      // Stage 1: Fast perceptual hash filtering
      const targetPerceptualHash = await PerceptualHasher.generatePerceptualHash(targetBuffer);
      logger.debug(`Target perceptual hash: ${targetPerceptualHash}`);

      // Load all screenshots and their perceptual hashes in parallel
      const stage1Results = await Promise.all(
        screenshotPaths.map(async (filePath) => {
          try {
            const { buffer, hash } = await ScreenshotCache.getCachedScreenshot(filePath);
            const perceptualSimilarity = PerceptualHasher.getPerceptualSimilarity(
              targetPerceptualHash,
              hash,
            );

            return {
              filePath,
              buffer,
              perceptualSimilarity,
              isCandidate: perceptualSimilarity >= minSimilarity - 10, // 10% buffer for perceptual hash
            };
          } catch (error) {
            logger.debug(
              `Failed to process ${path.basename(filePath)}: ${(error as Error).message}`,
            );
            return null;
          }
        }),
      );

      const candidates = stage1Results.filter(
        (result): result is NonNullable<typeof result> => result !== null && result.isCandidate,
      );

      const stage1Time = timer.now() - batchStart;
      logger.info(
        `Stage 1 (perceptual hash) completed in ${stage1Time}ms: ${candidates.length}/${screenshotPaths.length} candidates selected`,
      );

      if (candidates.length === 0) {
        return screenshotPaths.map((filePath) => ({
          filePath,
          similarity: 0,
          matchFound: false,
        }));
      }

      // Stage 2: Precise pixel comparison for candidates only
      const stage2Start = timer.now();
      const preciseResults = await Promise.all(
        candidates.map(async (candidate) => {
          try {
            const comparisonResult = await ScreenshotComparator.compareImages(
              targetBuffer,
              candidate.buffer,
              0.1,
              fastMode,
            );

            return {
              filePath: candidate.filePath,
              similarity: comparisonResult.similarity,
              matchFound: comparisonResult.similarity >= minSimilarity,
            };
          } catch (error) {
            logger.debug(
              `Stage 2 failed for ${path.basename(candidate.filePath)}: ${(error as Error).message}`,
            );
            return {
              filePath: candidate.filePath,
              similarity: 0,
              matchFound: false,
            };
          }
        }),
      );

      // Fill in results for non-candidates (indexed lookup, not O(n^2) .find())
      const finalResults = stitchBatchResults(screenshotPaths, preciseResults, stage1Results);

      const stage2Time = timer.now() - stage2Start;
      const totalTime = timer.now() - batchStart;
      const matches = finalResults.filter((r) => r.matchFound);

      logger.info(
        `Stage 2 (pixel comparison) completed in ${stage2Time}ms for ${candidates.length} candidates`,
      );
      logger.info(
        `Optimized batch comparison completed in ${totalTime}ms: ${matches.length}/${screenshotPaths.length} matches found`,
      );

      return finalResults;
    } catch (error) {
      const totalTime = timer.now() - batchStart;
      logger.warn(
        `Optimized batch comparison failed after ${totalTime}ms: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Find similar screenshots in cache directory within tolerance
   * @param targetBuffer Target screenshot buffer to compare against
   * @param cacheDir Cache directory to search
   * @param tolerancePercent Similarity tolerance percentage (e.g., 0.2 for 0.2%)
   * @param maxComparisons Maximum number of files to compare (default 10)
   * @returns Promise with similar screenshot result
   */
  static async findSimilarScreenshots(
    targetBuffer: Buffer,
    cacheDir: string,
    tolerancePercent: number = DEFAULT_FUZZY_MATCH_TOLERANCE_PERCENT,
    maxComparisons: number = 10,
    timer: Timer = defaultTimer,
  ): Promise<SimilarScreenshotResult> {
    const searchStart = timer.now();
    const minSimilarity = 100 - tolerancePercent;

    logger.info(
      `Searching for screenshots with ≥${minSimilarity}% similarity (tolerance: ${tolerancePercent}%) in ${cacheDir}`,
    );

    try {
      const screenshotFiles = await ScreenshotCache.getScreenshotFiles(cacheDir);

      if (screenshotFiles.length === 0) {
        logger.info("No screenshot files found in cache directory");
        return {
          filePath: "",
          similarity: 0,
          matchFound: false,
        };
      }

      // Take the newest maxComparisons files. Only k << n are needed, so select
      // the top-k by mtime in a single pass instead of a full O(n log n) sort.
      const filesWithStats = await Promise.all(
        screenshotFiles.map(async (filePath) => {
          const stats = await fsPromises.stat(filePath);
          return { filePath, mtime: stats.mtime.getTime() };
        }),
      );

      const filesToCheck = topKByDescending(filesWithStats, maxComparisons, (f) => f.mtime);

      logger.info(
        `Comparing against ${filesToCheck.length} most recent screenshots (max: ${maxComparisons})`,
      );

      let bestMatch: SimilarScreenshotResult = {
        filePath: "",
        similarity: 0,
        matchFound: false,
      };

      for (const { filePath } of filesToCheck) {
        try {
          logger.debug(`Comparing against: ${path.basename(filePath)}`);

          const cachedBuffer = await readFileAsync(filePath);
          const comparisonResult = await ScreenshotComparator.compareImages(
            targetBuffer,
            cachedBuffer,
            0.1,
            true,
          );

          logger.info(
            `${path.basename(filePath)}: ${comparisonResult.similarity.toFixed(2)}% similarity (${comparisonResult.pixelDifference}/${comparisonResult.totalPixels} different pixels)`,
          );

          if (comparisonResult.similarity > bestMatch.similarity) {
            bestMatch = {
              filePath,
              similarity: comparisonResult.similarity,
              matchFound: comparisonResult.similarity >= minSimilarity,
            };
          }

          // If we found a match within tolerance, we can stop searching
          if (comparisonResult.similarity >= minSimilarity) {
            logger.info(
              `✓ Found matching screenshot: ${path.basename(filePath)} (${comparisonResult.similarity.toFixed(2)}% similarity)`,
            );
            break;
          }
        } catch (error) {
          logger.warn(
            `Failed to compare against ${path.basename(filePath)}: ${(error as Error).message}`,
          );
        }
      }

      const searchTime = timer.now() - searchStart;

      if (bestMatch.matchFound) {
        logger.info(
          `Screenshot search completed in ${searchTime}ms: Found match with ${bestMatch.similarity.toFixed(2)}% similarity`,
        );
      } else {
        logger.info(
          `Screenshot search completed in ${searchTime}ms: No match found (best: ${bestMatch.similarity.toFixed(2)}%)`,
        );
      }

      return bestMatch;
    } catch (error) {
      const searchTime = timer.now() - searchStart;
      logger.warn(`Screenshot search failed after ${searchTime}ms: ${(error as Error).message}`);

      return {
        filePath: "",
        similarity: 0,
        matchFound: false,
      };
    }
  }
}
