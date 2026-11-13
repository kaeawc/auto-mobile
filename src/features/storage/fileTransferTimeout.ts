/** Per-command Android push budgets, shared with the outer request deadline. */
export const APP_FILE_PUSH_TIMEOUT_MS = 120_000;

/**
 * Size-scaled shared-storage push and backup budgets. A stage gets `bytes / minimum throughput`,
 * clamped between the floor (a small stalled transfer fails fast) and the ceiling. The per-file
 * ceiling is the per-file allotment of the `putAppFile` caller deadline, so a scaled push never
 * outlives the request that started it.
 */
export const SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS = 30_000;
export const SHARED_STORAGE_TRANSFER_TIMEOUT_CEILING_MS = APP_FILE_PUSH_TIMEOUT_MS;
/** Slowest sustained adb transfer still treated as healthy: 4 MiB/s. */
export const SHARED_STORAGE_MIN_TRANSFER_BYTES_PER_SECOND = 4 * 1024 * 1024;

/** Budget for moving `byteCount` bytes, between the floor and `ceilingMs`. */
function scaledTransferTimeoutMs(byteCount: number, ceilingMs: number): number {
  const bytes = Number.isFinite(byteCount) && byteCount > 0 ? byteCount : 0;
  const scaledMs = Math.ceil((bytes / SHARED_STORAGE_MIN_TRANSFER_BYTES_PER_SECOND) * 1000);
  return Math.min(Math.max(scaledMs, SHARED_STORAGE_TRANSFER_TIMEOUT_FLOOR_MS), ceilingMs);
}

/** Push budget for one shared-storage file of `byteCount` bytes. */
export function sharedStoragePushTimeoutMs(byteCount: number): number {
  return scaledTransferTimeoutMs(byteCount, SHARED_STORAGE_TRANSFER_TIMEOUT_CEILING_MS);
}

/**
 * Backup budget for one chunk: scaled by the chunk's incoming byte total (the size of the content
 * being replaced is unknown before the copy) and capped at one per-file ceiling per file, which the
 * caller deadline also allots per file.
 */
export function sharedStorageBackupTimeoutMs(byteCounts: readonly number[]): number {
  const total = byteCounts.reduce(
    (sum, count) => sum + (Number.isFinite(count) && count > 0 ? count : 0),
    0,
  );
  return scaledTransferTimeoutMs(
    total,
    Math.max(1, byteCounts.length) * SHARED_STORAGE_TRANSFER_TIMEOUT_CEILING_MS,
  );
}

export const SHARED_STORAGE_MKDIR_TIMEOUT_MS = 5_000;
export const SHARED_STORAGE_COMMIT_TIMEOUT_MS = 5_000;
export const SHARED_STORAGE_RESET_TIMEOUT_MS = 10_000;
export const SHARED_STORAGE_MEDIA_SCAN_TIMEOUT_MS = 10_000;
export const SHARED_STORAGE_MEDIA_QUERY_TIMEOUT_MS = 3_000;
export const SHARED_STORAGE_MEDIA_INDEX_TIMEOUT_MS = 5_000;
export const SHARED_STORAGE_MEDIA_POLL_INTERVAL_MS = 250;
export const SHARED_STORAGE_DIAGNOSTIC_TIMEOUT_MS = 4_000;
/** Let individual probes settle before the collector's fail-safe deadline. */
export const SHARED_STORAGE_DIAGNOSTICS_TOTAL_TIMEOUT_MS = 4_500;

/** Allowance per batch for setup, indexing, rollback and result serialization; not a bound on arbitrary extra commands. */
export const FILE_TRANSFER_MCP_TIMEOUT_HEADROOM_MS = 30_000;
