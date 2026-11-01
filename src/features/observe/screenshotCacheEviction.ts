import nodePath from "node:path";
import { screenshotFileDeviceToken } from "../../utils/screenshot/screenshotFormats";

export type ScreenshotPathModule = Pick<typeof nodePath, "normalize" | "sep">;

/** Lexical file identity without cwd resolution; Windows keys also ignore case. */
export function screenshotPathKey(
  path: string,
  pathModule: ScreenshotPathModule = nodePath,
): string {
  const normalized = pathModule.normalize(path);
  return pathModule.sep === "\\" ? normalized.toLowerCase() : normalized;
}

export interface ScreenshotCacheFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export const SCREENSHOT_CACHE_MAX_SIZE_BYTES = 128 * 1024 * 1024;

/** Shared screenshot admission limits, in bytes except for the per-device file count. */
export interface ScreenshotRetentionLimits {
  baseBytes: number;
  perDeviceBytes: number;
  ceilingBytes: number;
  keepPerDevice: number;
}

export const DEFAULT_SCREENSHOT_RETENTION_LIMITS: Readonly<ScreenshotRetentionLimits> = {
  baseBytes: SCREENSHOT_CACHE_MAX_SIZE_BYTES,
  perDeviceBytes: 64 * 1024 * 1024,
  ceilingBytes: 2 * 1024 * 1024 * 1024,
  keepPerDevice: 3,
};

/** Scale for active devices without lowering the base, even when the ceiling is smaller. */
export function effectiveScreenshotCacheBytes(
  limits: ScreenshotRetentionLimits,
  activeDevices: number,
): number {
  return Math.min(
    Math.max(limits.baseBytes, activeDevices * limits.perDeviceBytes),
    Math.max(limits.ceilingBytes, limits.baseBytes),
  );
}

/**
 * Capacity that also honours the return guarantee: bytes still inside their guarantee lift
 * the device-scaled capacity, up to the ceiling. Only past the ceiling does admission evict
 * a frame before its guarantee expires (#15182: 3.2 MB frames every 10 s need about 192 MiB
 * per device for the 10-minute guarantee, three times the per-device scale).
 */
export function guaranteedScreenshotCacheBytes(
  limits: ScreenshotRetentionLimits,
  activeDevices: number,
  guaranteedBytes: number,
): number {
  return Math.min(
    Math.max(effectiveScreenshotCacheBytes(limits, activeDevices), guaranteedBytes),
    Math.max(limits.ceilingBytes, limits.baseBytes),
  );
}

/**
 * Path keys for each device's newest K files by last touch. Reserve one slot for an
 * incoming device's new frame; legacy names have no device and receive no slots.
 * Supply the same path-key function used by the caller's inventory.
 */
export function newestScreenshotPathKeys(
  files: readonly ScreenshotCacheFile[],
  keepPerDevice: number,
  touched: (file: ScreenshotCacheFile) => number,
  {
    incomingDevice,
    key = screenshotPathKey,
  }: { incomingDevice?: string; key?: (path: string) => string } = {},
): Set<string> {
  const counts = new Map<string, number>();
  if (incomingDevice) {
    counts.set(incomingDevice, 1);
  }
  const kept = new Set<string>();
  for (const file of [...files].sort((a, b) => touched(b) - touched(a))) {
    const device = screenshotFileDeviceToken(nodePath.basename(file.path));
    if (!device) {
      continue;
    }
    const count = counts.get(device) ?? 0;
    if (count < keepPerDevice) {
      kept.add(key(file.path));
      counts.set(device, count + 1);
    }
  }
  return kept;
}

export interface ScreenshotEvictionPlan {
  /** Oldest-first paths to delete. */
  toEvict: string[];
  /** Whether the total size after applying `toEvict` still exceeds the budget. */
  overBudgetAfterEviction: boolean;
  /** Age-eligible referenced files encountered while the plan was still over budget. */
  skippedReferenced: number;
}

export interface ScreenshotEvictionGuards {
  /** A file still referenced by a live cache entry is skipped and counted in `skippedReferenced`. */
  isReferenced?: (path: string) => boolean;
  /** A protected file is never selected. */
  isProtected?: (path: string) => boolean;
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
  {
    nowMs,
    isReferenced = () => false,
    isProtected = () => false,
  }: ScreenshotEvictionGuards & { nowMs: number },
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
