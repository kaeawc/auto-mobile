export interface ScreenshotCacheFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Minimum age before a screenshot is eligible for size-based eviction.
 *
 * The screenshots cache dir is shared by every process that writes there. In
 * production each agent runs its own (non-proxy) MCP client process, so unless
 * operators isolate TMPDIR per agent, multiple processes write here. Screenshot
 * filenames are timestamp-only (not keyed by process/device), so size-based
 * eviction could otherwise delete a frame another process just captured and is
 * still reading. Protecting recent files closes that window; a captured frame is
 * consumed within milliseconds, so 30s is comfortably safe.
 */
export const SCREENSHOT_MIN_EVICT_AGE_MS = 30_000;

/**
 * Pure selector for size-based screenshot eviction. Returns the paths to delete:
 * oldest-first until under `maxSizeBytes`, but never a file younger than
 * `minAgeMs` (which may be an in-flight capture from another process sharing the
 * cache directory).
 */
export function selectScreenshotsToEvict(
  files: ScreenshotCacheFile[],
  maxSizeBytes: number,
  minAgeMs: number,
  nowMs: number,
): string[] {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= maxSizeBytes) {
    return [];
  }

  const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  const toDelete: string[] = [];
  let current = total;

  for (const file of sorted) {
    if (current <= maxSizeBytes) {
      break;
    }
    if (nowMs - file.mtimeMs < minAgeMs) {
      // Too recent to evict — may be another process's in-flight frame.
      continue;
    }
    toDelete.push(file.path);
    current -= file.size;
  }

  return toDelete;
}
