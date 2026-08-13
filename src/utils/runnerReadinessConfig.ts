export const RUNNER_READINESS_TIMEOUT_ENV = "AUTOMOBILE_RUNNER_READINESS_TIMEOUT_MS";
export const RUNNER_READINESS_TIMEOUT_FLAG = "--runner-readiness-timeout-ms";
export const DEFAULT_RUNNER_READINESS_TIMEOUT_MS = 30_000;
export const MIN_RUNNER_READINESS_TIMEOUT_MS = 1_000;
export const MAX_RUNNER_READINESS_TIMEOUT_MS = 120_000;

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
