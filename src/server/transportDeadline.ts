import {
  currentRequestDeadline,
  type RequestDeadline,
} from "../features/toolSelection/toolSelectionContext";

/**
 * Recover the ABSOLUTE deadline of the current MCP request from the request
 * deadline the call runs under (issue #6222 P1; ambient since #15663).
 *
 * Prefers `deadlineMs` (the daemon's `__mcpRequestDeadlineMs`), an absolute
 * deadline the DAEMON anchored at the instant it captured the remaining
 * transport budget, immediately before the loopback `mcpClient.callTool`
 * (`UnixSocketServer.withSocketSessionAutolockKey`). Falls back to recomputing
 * `startTime + timeoutMs` only when the newer param is absent (an older daemon
 * build): `startTime` is this execution's own start time on the SAME `defaultTimer` clock
 * `SetUIState` uses, but it is recorded only AFTER this process's HTTP
 * dispatch and admission/tool-selection repo reads -- re-deriving the
 * deadline from it RE-GRANTS whatever time that gap consumed, which can push
 * the computed deadline later than the daemon's actual outer abort (issue
 * #6222 review, PRRT_kwDOP-GF5M6fuyts P1). The anchored param removes that
 * gap entirely, so it is the preferred source whenever present.
 *
 * Neither is present on a direct, non-daemon call, in which case there
 * is no transport deadline to bound against and `SetUIState` falls back to
 * its own conservative internal budget.
 */
export function resolveTransportDeadlineMs(
  requestDeadline: RequestDeadline | undefined = currentRequestDeadline(),
): number | undefined {
  if (!requestDeadline) {
    return undefined;
  }
  const anchoredDeadlineMs = requestDeadline.deadlineMs;
  if (typeof anchoredDeadlineMs === "number" && Number.isFinite(anchoredDeadlineMs)) {
    return anchoredDeadlineMs;
  }
  const remainingMs = requestDeadline.timeoutMs;
  const startTimeMs = requestDeadline.startTime;
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
