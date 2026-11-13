/** Per-command Android push budgets, shared with the outer request deadline. */
export const SHARED_STORAGE_PUSH_TIMEOUT_MS = 90_000;
export const APP_FILE_PUSH_TIMEOUT_MS = 120_000;

export const SHARED_STORAGE_MKDIR_TIMEOUT_MS = 5_000;
export const SHARED_STORAGE_COMMIT_TIMEOUT_MS = 5_000;
export const SHARED_STORAGE_RESET_TIMEOUT_MS = 10_000;
export const SHARED_STORAGE_BACKUP_TIMEOUT_MS = 90_000;
export const SHARED_STORAGE_MEDIA_SCAN_TIMEOUT_MS = 10_000;
export const SHARED_STORAGE_MEDIA_QUERY_TIMEOUT_MS = 3_000;
export const SHARED_STORAGE_MEDIA_INDEX_TIMEOUT_MS = 5_000;
export const SHARED_STORAGE_MEDIA_POLL_INTERVAL_MS = 250;
export const SHARED_STORAGE_DIAGNOSTIC_TIMEOUT_MS = 4_000;
/** Let individual probes settle before the collector's fail-safe deadline. */
export const SHARED_STORAGE_DIAGNOSTICS_TOTAL_TIMEOUT_MS = 4_500;

/** Allowance per batch for setup, indexing, rollback and result serialization; not a bound on arbitrary extra commands. */
export const FILE_TRANSFER_MCP_TIMEOUT_HEADROOM_MS = 30_000;
