/** Per-command Android push budgets, shared with the outer request deadline. */
export const SHARED_STORAGE_PUSH_TIMEOUT_MS = 120_000;
export const APP_FILE_PUSH_TIMEOUT_MS = 120_000;

/** Allowance per batch for setup, indexing, rollback and result serialization; not a bound on arbitrary extra commands. */
export const FILE_TRANSFER_MCP_TIMEOUT_HEADROOM_MS = 30_000;
