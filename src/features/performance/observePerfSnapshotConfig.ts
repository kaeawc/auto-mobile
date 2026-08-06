/**
 * Opt-in configuration for the windowed performance snapshot attached to
 * `observe` results (`ObserveResult.perfSnapshot`).
 *
 * The feature is OFF by default and independent of `--debug-perf`: enabling it
 * makes `observe` start per-device performance sampling and roll the live
 * stream up into a windowed snapshot. This mirrors the env-gate shape of
 * `performanceAuditConfig.ts`.
 */

const ENABLE_ENV = "AUTOMOBILE_OBSERVE_PERF_SNAPSHOT";
const WINDOW_ENV = "AUTOMOBILE_OBSERVE_PERF_WINDOW_MS";

/** Default rolling window when the env var is unset or invalid. */
export const DEFAULT_PERF_WINDOW_MS = 5000;
/** Lower clamp: below this a window holds too few samples to be meaningful. */
export const MIN_PERF_WINDOW_MS = 1000;
/** Upper clamp: bounded by the buffer's retention cap. */
export const MAX_PERF_WINDOW_MS = 30000;

function parseEnvBoolean(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** Whether observe should attach a windowed performance snapshot. */
export function isObservePerfSnapshotEnabled(): boolean {
  return parseEnvBoolean(process.env[ENABLE_ENV]);
}

/**
 * Rolling window span (ms) for the snapshot, from `AUTOMOBILE_OBSERVE_PERF_WINDOW_MS`,
 * defaulting to {@link DEFAULT_PERF_WINDOW_MS} and clamped to
 * [{@link MIN_PERF_WINDOW_MS}, {@link MAX_PERF_WINDOW_MS}]. A missing, non-numeric,
 * or non-positive value falls back to the default.
 */
export function getObservePerfWindowMs(): number {
  const raw = process.env[WINDOW_ENV]?.trim();
  if (!raw) {
    return DEFAULT_PERF_WINDOW_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PERF_WINDOW_MS;
  }
  return Math.min(MAX_PERF_WINDOW_MS, Math.max(MIN_PERF_WINDOW_MS, Math.round(parsed)));
}
