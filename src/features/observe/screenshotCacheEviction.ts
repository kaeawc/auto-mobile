export interface ScreenshotCacheFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Returned paths receive 30 seconds from publication in this process: the
 * shortest existing retention floor (formerly measured only from file mtime).
 * This is not a measured client-consumption duration. Other processes still
 * honor the same 30-second mtime floor, but cannot see process-local protection.
 */
export const SCREENSHOT_MIN_LIFETIME_MS = 30_000;
export const SCREENSHOT_CACHE_MAX_SIZE_BYTES = 128 * 1024 * 1024;
/** Same 24-hour stale-age policy as automatic tool-output artifacts; far beyond
 * the 30-second return window and other processes' five-minute cache TTL. */
export const SCREENSHOT_STALE_AGE_MS = 24 * 60 * 60 * 1000;

export interface ScreenshotEvictionPlan {
  /** Oldest-first paths to delete. */
  toEvict: string[];
  /** Whether the total size after applying `toEvict` still exceeds the budget. */
  overBudgetAfterEviction: boolean;
  /** Age-eligible referenced files encountered while the plan was still over budget. */
  skippedReferenced: number;
}

/**
 * Pure selector for size-based screenshot eviction. Plans oldest-first deletion
 * until under `maxSizeBytes`, but never selects a file younger than `minAgeMs`
 * or a file still referenced by a live cache entry.
 */
export function selectScreenshotsToEvict(
  files: ScreenshotCacheFile[],
  maxSizeBytes: number,
  minAgeMs: number,
  nowMs: number,
  isReferenced: (path: string) => boolean = () => false,
  isProtected: (path: string) => boolean = () => false,
): ScreenshotEvictionPlan {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= maxSizeBytes) {
    return { toEvict: [], overBudgetAfterEviction: false, skippedReferenced: 0 };
  }

  const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  const toDelete: string[] = [];
  let current = total;
  let skippedReferenced = 0;

  for (const file of sorted) {
    if (current <= maxSizeBytes) {
      break;
    }
    if (nowMs - file.mtimeMs < minAgeMs) {
      // Too recent to evict — may be another process's in-flight frame.
      continue;
    }
    if (isProtected(file.path)) {
      continue;
    }
    if (isReferenced(file.path)) {
      skippedReferenced += 1;
      continue;
    }
    toDelete.push(file.path);
    current -= file.size;
  }

  return {
    toEvict: toDelete,
    overBudgetAfterEviction: current > maxSizeBytes,
    skippedReferenced,
  };
}
