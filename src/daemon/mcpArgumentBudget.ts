import {
  DEFAULT_STABLE_WAIT_FOR_TIMEOUT_MS,
  DEFAULT_WAIT_FOR_TIMEOUT_MS,
  WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
} from "../features/observe/waitForTimeout";
import { MAX_SETTIMEOUT_DELAY_MS } from "../utils/SystemTimer";

/**
 * Argument-derived MCP request budgets shared by `mcpRequestTimeout` (moved out of it
 * to keep that module under the file-size cap).
 */

/**
 * Upper bound on a caller-supplied `DaemonRequest.timeoutMs` (#6385). Clients
 * now send their own deadline, and the daemon honours it -- but a buggy or
 * hostile value (e.g. `Number.MAX_SAFE_INTEGER`) must not pin a request's
 * device lock and queue slot indefinitely, nor overflow `setTimeout` (which
 * fires immediately past `MAX_SETTIMEOUT_DELAY_MS`). Server-derived per-tool
 * floors are applied after this clamp, so a tool whose own floor is larger
 * still gets it.
 */
export const MAX_CALLER_MCP_REQUEST_TIMEOUT_MS = 1_800_000;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Invalid/non-positive/non-finite budgets use the tool default, matching device
 * preparation. Oversized finite values (including budget + headroom) saturate at
 * the caller cap; no transport headroom can be guaranteed at that ceiling.
 */
export function resolveArgumentTimeoutBudgetMs(
  raw: unknown,
  defaultMs: number,
  headroomMs: number,
): number {
  return Math.min(
    (positiveFiniteNumber(raw) ?? defaultMs) + headroomMs,
    MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
    MAX_SETTIMEOUT_DELAY_MS,
  );
}

export function resolveObserveWaitBudgetMs(args: Record<string, unknown>): number {
  const waitFor = asRecord(args.waitFor);
  if (!waitFor) {
    return 0;
  }
  const defaultMs =
    waitFor.for === "stable" ? DEFAULT_STABLE_WAIT_FOR_TIMEOUT_MS : DEFAULT_WAIT_FOR_TIMEOUT_MS;
  // Both legacy predicates and the `for` DSL read these nested aliases in this
  // order. Top-level timeoutMs is not a wait budget; schema validation owns it.
  return resolveArgumentTimeoutBudgetMs(
    waitFor.timeout ?? waitFor.timeoutMs,
    defaultMs,
    WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
  );
}

/**
 * `mediaSession` polls dumpsys: `waitFor` for up to its timeout, a dispatch for its settle
 * window (#14117). Every call gets the wait budget, so the default floor is one value.
 */
export function resolveMediaSessionWaitBudgetMs(args: Record<string, unknown>): number {
  return resolveArgumentTimeoutBudgetMs(
    asRecord(args.waitFor)?.timeoutMs,
    DEFAULT_WAIT_FOR_TIMEOUT_MS,
    WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
  );
}
