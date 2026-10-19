import type { DeviceCapabilities } from "./DeviceCapabilities";

/**
 * Performance metrics collected during audit
 */
export interface PerformanceMetrics {
  // Frame timing metrics
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;

  // Jank indicators, measured over the audit window (PERF_AUDIT_WINDOW_MS) from
  // two cumulative gfxinfo readings (#10094).
  /** Janky frames per second over the window (the unit of `jankCountThreshold`). */
  jankCount: number | null;
  /** Raw per-cause deltas over the window; the causes overlap, so never sum them. */
  missedVsyncCount: number | null;
  slowUiThreadCount: number | null;
  frameDeadlineMissedCount: number | null;

  // CPU metrics
  /**
   * Process CPU time over the audit window as a percentage of ONE core, from
   * two /proc/<pid>/stat readings (#10094). Can exceed 100 for a
   * multi-threaded process.
   */
  cpuUsagePercent: number | null;
  threadCount: number | null;

  // Touch latency
  touchLatencyMs: number | null;

  // ANR detection
  anrDetected: boolean;
  anrDetails: string | null;

  // Live metrics extension
  timeToFirstFrameMs: number | null;
  timeToInteractiveMs: number | null;
  frameRateFps: number | null;

  // Raw diagnostics
  gfxinfoRaw: string | null;
  cpuStatsRaw: string | null;
}

/**
 * Performance audit result
 */
export interface PerformanceAuditResult {
  passed: boolean;
  metrics: PerformanceMetrics;
  violations: PerformanceViolation[];
  diagnostics: string | null;
  deviceCapabilities: DeviceCapabilities;
}

/**
 * Represents a single performance threshold violation
 */
export interface PerformanceViolation {
  metric: string;
  threshold: number;
  actual: number;
  severity: "warning" | "critical";
  contributionWeight: number; // 0-1, how much this contributes to the overall issue
}
