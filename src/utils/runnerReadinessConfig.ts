export const RUNNER_READINESS_TIMEOUT_ENV = "AUTOMOBILE_RUNNER_READINESS_TIMEOUT_MS";
export const RUNNER_READINESS_TIMEOUT_FLAG = "--runner-readiness-timeout-ms";
export const DEFAULT_RUNNER_READINESS_TIMEOUT_MS = 30_000;
export const MIN_RUNNER_READINESS_TIMEOUT_MS = 1_000;
export const MAX_RUNNER_READINESS_TIMEOUT_MS = 120_000;

/**
 * Boot-class budget for the one-time runner PROVISIONING (CtrlProxy download +
 * cold `xcodebuild`/install launch) on a fresh device — the setup phases, which
 * `RunnerReadinessService` bounds by the request's `totalDeadlineMs` rather than
 * the short steady-state `readinessTimeoutMs`. A cold iOS CtrlProxy launch has
 * been observed to take ~90–115s, so the session-auto-start path (which owns no
 * separate boot budget) uses this as its total deadline while keeping
 * `readinessTimeoutMs` for the fast-fail health window (#5376).
 */
export const DEFAULT_RUNNER_PROVISION_TIMEOUT_MS = 180_000;

export function parseRunnerReadinessTimeout(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_RUNNER_READINESS_TIMEOUT_MS ||
    parsed > MAX_RUNNER_READINESS_TIMEOUT_MS
  ) {
    return undefined;
  }
  return parsed;
}
