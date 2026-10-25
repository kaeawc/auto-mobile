import {
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
} from "../daemon/wire/constants";

/**
 * Recover the ABSOLUTE deadline of the current MCP request from the internal
 * params the server attaches to every daemon-forwarded call (issue #6222
 * P1).
 *
 * Prefers `__mcpRequestDeadlineMs` ({@link INTERNAL_MCP_REQUEST_DEADLINE_PARAM}),
 * an absolute deadline the DAEMON anchored at the instant it captured the
 * remaining transport budget, immediately before the loopback
 * `mcpClient.callTool` (`UnixSocketServer.withSocketSessionAutolockKey`).
 * Falls back to recomputing `__executionStartTime + __mcpRequestTimeoutMs`
 * only when the newer param is absent (an older daemon build): `startTime`
 * is this execution's own start time on the SAME `defaultTimer` clock
 * `SetUIState` uses, but it is recorded only AFTER this process's HTTP
 * dispatch and admission/tool-selection repo reads -- re-deriving the
 * deadline from it RE-GRANTS whatever time that gap consumed, which can push
 * the computed deadline later than the daemon's actual outer abort (issue
 * #6222 review, PRRT_kwDOP-GF5M6fuyts P1). The anchored param removes that
 * gap entirely, so it is the preferred source whenever present.
 *
 * Neither field is present on a direct, non-daemon call, in which case there
 * is no transport deadline to bound against and `SetUIState` falls back to
 * its own conservative internal budget.
 */
export function resolveTransportDeadlineMs(args: unknown): number | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const anchoredDeadlineMs = record[INTERNAL_MCP_REQUEST_DEADLINE_PARAM];
  if (typeof anchoredDeadlineMs === "number" && Number.isFinite(anchoredDeadlineMs)) {
    return anchoredDeadlineMs;
  }
  const remainingMs = record[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM];
  const startTimeMs = record[INTERNAL_EXECUTION_START_TIME_PARAM];
  if (
    typeof remainingMs !== "number" ||
    !Number.isFinite(remainingMs) ||
    remainingMs <= 0 ||
    typeof startTimeMs !== "number" ||
    !Number.isFinite(startTimeMs)
  ) {
    return undefined;
  }
  return startTimeMs + remainingMs;
}
