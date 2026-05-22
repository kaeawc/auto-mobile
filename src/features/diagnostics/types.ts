/**
 * Public JSON shape for an end-of-run health summary file.
 *
 * No `version` field by design — these files are written and read by the same
 * package version, never persisted across major upgrades. If we need cross-
 * version compatibility later, add a `kind` field for self-identification
 * (cheaper than maintaining bump rules nobody reads).
 *
 * Platform coverage caveat:
 * `screenshot`, `backStack`, `accessibilityDetector`, `awaitIdle`, and
 * `hierarchy` are populated only on Android today — the corresponding iOS
 * code paths are separate and currently un-instrumented. iOS-only runs will
 * see count=0 across those sections; `toolCalls` and `ghostTap` are the
 * cross-platform metrics that remain accurate either way.
 */

export type HierarchyOutcome =
  // Cache served the call without waiting on the WebSocket.
  | "cache-hit"
  // WebSocket delivered fresh data within the wait timeout.
  | "fresh"
  // WebSocket wait timed out, served stale cache as fallback.
  | "stale"
  // WebSocket wait timed out and there was no cache to fall back to.
  | "timeout"
  // Pre-WebSocket failure — ensureConnected returned false, the call threw,
  // or the skipWaitForFresh path returned null. Returned `{hierarchy: null}`.
  | "failed";

export type AwaitIdleOutcome =
  // UI reached stability within the timeout.
  | "settled"
  // Wait timed out without reaching stability.
  | "timeout"
  // Polling loop threw — recorded distinctly so timeoutRate isn't inflated by aborts.
  | "error";

export type GhostTapRetryOutcome =
  // Post-tap hierarchy differs from pre-tap hierarchy. Tap was real; no retry needed.
  | "tap-registered"
  // Post-tap hierarchy is non-null and matches pre-tap. Tap presumed ghost; retry fired.
  | "false-positive"
  // Post-tap hierarchy unavailable (null). We can't verify; retry fired defensively.
  | "bailed-null-hierarchy";

export interface LatencyPercentiles {
  count: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface ScreenshotStats {
  count: number;
  latencyMs: LatencyPercentiles;
}

export interface HierarchyStats {
  /** Total hierarchy retrievals — includes cache hits, fresh deliveries, stale fallbacks, timeouts, and failed setups. */
  syncRequests: number;
  /** Calls served straight from the in-memory cache without waiting on the WebSocket. */
  cacheHits: number;
  /** WebSocket waits that delivered fresh data within the configured timeout. */
  freshDeliveries: number;
  /** WebSocket waits that timed out but a cached value was returned. */
  staleCacheReturns: number;
  /** WebSocket waits that timed out with no cache available. */
  timeouts: number;
  /** Pre-WebSocket failures (connection refused, ensureConnected returned false, thrown errors). */
  failed: number;
  /** `cacheHits / syncRequests` — high values mean we're saving WebSocket round-trips. */
  cacheHitRate: number;
  /** `staleCacheReturns / syncRequests` — high values indicate the WebSocket is unreliable. */
  stalenessRate: number;
  /**
   * End-to-end latency for `fresh` outcomes only — measured from
   * `getLatestHierarchy()` entry to the fresh-data return. Includes the cache
   * check + WebSocket wait, not just the push leg.
   */
  freshLatencyMs: LatencyPercentiles;
}

export interface AwaitIdleStats {
  calls: number;
  /** Polling loop completed but never reached the stability threshold. */
  timeouts: number;
  /** Polling loop threw — tracked in its own counter so `timeoutRate` doesn't conflate with `errorRate`. */
  errors: number;
  /** `timeouts / calls`. Errors live in `errorRate` and do not inflate this number. */
  timeoutRate: number;
  /** `errors / calls`. Distinct bucket from `timeoutRate`. */
  errorRate: number;
  /**
   * Wall-clock time spent in `awaitIdle()` across all outcomes (settled, timeout, error).
   * Mixing is intentional — the metric answers "how long does this call take?", not
   * "how long do successful settles take?".
   */
  durationMs: LatencyPercentiles;
}

export interface ToolCallStats {
  count: number;
  successes: number;
  failures: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface GhostTapStats {
  evaluations: number;
  tapRegistered: number;
  falsePositives: number;
  bailedNullHierarchy: number;
  falsePositiveRate: number;
}

export interface BackStackStats {
  count: number;
  latencyMs: LatencyPercentiles;
}

export interface AccessibilityDetectorStats {
  count: number;
  latencyMs: LatencyPercentiles;
}

export interface RunHealthSummary {
  /**
   * Session UUID from the JUnit runner / `--session-uuid` CLI flag if provided,
   * `null` for ad-hoc runs that have no session context to correlate against.
   */
  sessionId: string | null;
  planName: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  device: {
    id: string | null;
    model: string | null;
  } | null;
  screenshot: ScreenshotStats;
  backStack: BackStackStats;
  accessibilityDetector: AccessibilityDetectorStats;
  hierarchy: HierarchyStats;
  awaitIdle: AwaitIdleStats;
  toolCalls: {
    total: number;
    successes: number;
    failures: number;
    byTool: Record<string, ToolCallStats>;
  };
  ghostTap: GhostTapStats;
}

export interface DeviceInfo {
  id: string | null;
  model: string | null;
}
