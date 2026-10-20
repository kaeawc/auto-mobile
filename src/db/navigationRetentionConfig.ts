import { readOptionalEnvPositiveInteger } from "../utils/envNumbers";
import { ENV, type EnvVarSpec } from "../config/env";

/** Tunable retention thresholds. All durations are milliseconds. */
export interface NavigationRetentionConfig {
  /** SHORT tier: max age of a node screenshot before its pointer is cleared. */
  screenshotTtlMs: number;
  /** LONG tier: max age of an observation row before it is pruned. */
  structureTtlMs: number;
  /** Backstop: max observation rows kept per app. */
  perAppMaxObservations: number;
  /** Backstop: max observation rows kept across all apps. */
  globalMaxObservations: number;
  /**
   * Max ids bound in one batched DELETE/UPDATE. Clamped to
   * {@link MAX_EVICTION_CHUNK_SIZE} so a misconfigured value can never approach
   * bun:sqlite's `MAX_VARIABLE_NUMBER` (250_000) and defeat the batching.
   */
  evictionChunkSize: number;
  /**
   * Max `navigation_edges` rows (traversals) kept per distinct transition; the newest
   * by insertion order are kept. Config/override only (no env var).
   */
  maxEdgeTraversalsPerTransition: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Conservative defaults (hand-off merge — the maintainer owns the final policy):
// nothing surprising should be deleted, so screenshots live a week and structure
// three months, with generous size caps that only trip on genuine runaway growth.
export const DEFAULT_SCREENSHOT_TTL_MS = 7 * DAY_MS; // 7 days
export const DEFAULT_STRUCTURE_TTL_MS = 90 * DAY_MS; // ~3 months
export const DEFAULT_PER_APP_MAX_OBSERVATIONS = 50_000;
export const DEFAULT_GLOBAL_MAX_OBSERVATIONS = 500_000;
export const DEFAULT_EVICTION_CHUNK_SIZE = 5_000;
export const DEFAULT_MAX_EDGE_TRAVERSALS_PER_TRANSITION = 20;

/** Default cadence of the background pass: every 6 hours. */
export const DEFAULT_NAV_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Hard SQLite/runtime ceilings the config is validated against.
// A single DELETE/UPDATE binds at most this many ids — comfortably under
// bun:sqlite's MAX_VARIABLE_NUMBER (250_000), and small enough that each batch
// statement stays cheap.
export const MAX_EVICTION_CHUNK_SIZE = 10_000;
// setInterval delays above the signed-32-bit max are silently clamped to 1ms by
// the runtime, so an interval over this is treated as invalid and defaulted.
export const MAX_INTERVAL_MS = 2_147_483_647;

/**
 * Deletes a screenshot file previously referenced by a pruned node. Injected so
 * unit tests observe the calls without touching disk; production wires the
 * canonical filesystem unlink.
 */
export type ScreenshotFileRemover = (filePath: string) => Promise<void>;

/** Outcome of a single prune pass, surfaced for logging / a storage indicator. */
export interface NavigationRetentionSummary {
  screenshotsCleared: number;
  nodeObservationsDeleted: number;
  edgeObservationsDeleted: number;
  suggestionObservationsDeleted: number;
  buildKeysDeleted: number;
  /** Surplus `navigation_edges` traversal rows deleted (see the per-transition cap). */
  edgeTraversalsDeleted: number;
  /** Clock time (ms) the pass ran at. */
  prunedAt: number;
}

export function emptySummary(prunedAt: number): NavigationRetentionSummary {
  return {
    screenshotsCleared: 0,
    nodeObservationsDeleted: 0,
    edgeObservationsDeleted: 0,
    suggestionObservationsDeleted: 0,
    buildKeysDeleted: 0,
    edgeTraversalsDeleted: 0,
    prunedAt,
  };
}

/** A positive safe integer within `[1, max]`, else undefined (0/neg/NaN/float/too-big). */
function sanitizePositiveInt(
  value: number | undefined,
  max: number = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : undefined;
}

/**
 * Strict env read: the ENTIRE trimmed value must be a run of digits, so partial
 * parses that `Number.parseInt` would silently accept ("1e6" -> 1, "12abc" -> 12)
 * are rejected and fall back to the default rather than becoming a 1ms interval.
 * The parsed value is then bounded by `max`.
 */
function readPositiveIntEnv(spec: EnvVarSpec, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return sanitizePositiveInt(readOptionalEnvPositiveInteger(spec.name, spec.legacyName), max);
}

/**
 * Resolve the retention config from explicit overrides, then env, then the
 * conservative defaults. Every source is validated against its REAL ceiling — not
 * just positivity — so a stray `perAppMaxObservations: 0`, a float, or an
 * oversized chunk falls back / clamps rather than corrupting the pass.
 */
export function resolveNavigationRetentionConfig(
  overrides: Partial<NavigationRetentionConfig> = {},
): NavigationRetentionConfig {
  const resolve = (
    override: number | undefined,
    envSpec: EnvVarSpec,
    def: number,
    max: number = Number.MAX_SAFE_INTEGER,
  ): number => sanitizePositiveInt(override, max) ?? readPositiveIntEnv(envSpec, max) ?? def;

  return {
    screenshotTtlMs: resolve(
      overrides.screenshotTtlMs,
      ENV.NAV_RETENTION_SCREENSHOT_TTL_MS,
      DEFAULT_SCREENSHOT_TTL_MS,
    ),
    structureTtlMs: resolve(
      overrides.structureTtlMs,
      ENV.NAV_RETENTION_STRUCTURE_TTL_MS,
      DEFAULT_STRUCTURE_TTL_MS,
    ),
    perAppMaxObservations: resolve(
      overrides.perAppMaxObservations,
      ENV.NAV_RETENTION_PER_APP_MAX_OBSERVATIONS,
      DEFAULT_PER_APP_MAX_OBSERVATIONS,
    ),
    globalMaxObservations: resolve(
      overrides.globalMaxObservations,
      ENV.NAV_RETENTION_GLOBAL_MAX_OBSERVATIONS,
      DEFAULT_GLOBAL_MAX_OBSERVATIONS,
    ),
    // Resolve as a positive integer, then clamp to the hard batch ceiling so any
    // configured value keeps the batching effective.
    evictionChunkSize: Math.min(
      resolve(
        overrides.evictionChunkSize,
        ENV.NAV_RETENTION_EVICTION_CHUNK_SIZE,
        DEFAULT_EVICTION_CHUNK_SIZE,
      ),
      MAX_EVICTION_CHUNK_SIZE,
    ),
    maxEdgeTraversalsPerTransition:
      sanitizePositiveInt(overrides.maxEdgeTraversalsPerTransition) ??
      DEFAULT_MAX_EDGE_TRAVERSALS_PER_TRANSITION,
  };
}

/**
 * Resolve the background-pass interval (ms) from override, env, or the default,
 * bounded by the signed-32-bit setInterval ceiling (a larger value would be
 * clamped to 1ms by the runtime, so it is rejected and defaulted).
 */
export function resolveNavigationRetentionIntervalMs(override?: number): number {
  return (
    sanitizePositiveInt(override, MAX_INTERVAL_MS) ??
    readPositiveIntEnv(ENV.NAV_RETENTION_INTERVAL_MS, MAX_INTERVAL_MS) ??
    DEFAULT_NAV_RETENTION_INTERVAL_MS
  );
}
