/** Defaults shared by observe polling and its request deadline. */
export const DEFAULT_WAIT_FOR_TIMEOUT_MS = 5000;
export const DEFAULT_STABLE_WAIT_FOR_TIMEOUT_MS = 2500;

/** Allowance for wait dispatch and the terminal observation/report to return. */
export const WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS = 30_000;

/** Keep an observe wait plus its dispatch/report headroom within the caller's 30-minute cap. */
export const MAX_WAIT_FOR_TIMEOUT_MS = 1_800_000 - WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS;
