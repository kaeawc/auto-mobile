import { getLiveDeadlineMs } from "../daemon/liveDeadlineRegistry";
import {
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
} from "../daemon/constants";
import type { ToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { resolveTransportDeadlineMs } from "./formTools";

/**
 * Time kept back from the request's remaining budget so an allocation that
 * cannot finish returns its own actionable timeout error before the client's
 * transport timeout fires (#10153: a 300 s default wait outlived a 120 s client
 * timeout, so the caller only ever saw a transport error).
 */
export const ALLOCATION_BUDGET_RESERVE_MS = 5_000;

/**
 * Bound a plan's device-allocation wait by the budget the enclosing request has
 * left. A request without a known deadline (direct call, tests) keeps the
 * requested timeout. The result is never negative: a spent budget makes the
 * allocation a single attempt.
 */
export function boundAllocationTimeoutMs(
  requestedMs: number,
  planRequest: ToolSelectionContext["planRequest"],
  nowMs: number,
): number {
  const deadlineMs = resolveRequestDeadlineMs(planRequest);
  if (deadlineMs === undefined) {
    return requestedMs;
  }
  return Math.max(0, Math.min(requestedMs, deadlineMs - nowMs - ALLOCATION_BUDGET_RESERVE_MS));
}

function resolveRequestDeadlineMs(
  planRequest: ToolSelectionContext["planRequest"],
): number | undefined {
  if (!planRequest) {
    return undefined;
  }
  // The live deadline can have been extended by progress; prefer it when the
  // daemon registered one for this exact request.
  const liveKey = planRequest.liveDeadlineKey;
  const liveDeadlineMs = typeof liveKey === "string" ? getLiveDeadlineMs(liveKey) : undefined;
  return (
    liveDeadlineMs ??
    resolveTransportDeadlineMs({
      [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: planRequest.deadlineMs,
      [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: planRequest.timeoutMs,
      [INTERNAL_EXECUTION_START_TIME_PARAM]: planRequest.startTime,
    })
  );
}
