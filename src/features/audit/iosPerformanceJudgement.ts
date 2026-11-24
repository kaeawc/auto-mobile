import { DEFAULT_THRESHOLDS } from "../../daemon/streams/performancePushSocketServer";
import type { PerformanceMetrics, PerformanceViolation } from "../../models/PerformanceAuditResult";
import type { SdkFrameSample } from "../performance/SdkFrameMetricsStore";
import type { OnDemandPerformanceResult, UnsupportedAudit } from "./OnDemandAudit";

export const IOS_AUDIT_WINDOW_MS = 3000;
export const IOS_RSS_GROWTH_WARNING_MB = 25;
export const IOS_RSS_GROWTH_CRITICAL_MB = 37.5;

export interface IosMemoryAuditResult {
  passed: boolean;
  metrics: { rssStartMb: number; rssEndMb: number; rssGrowthMb: number; windowMs: number };
  violations: PerformanceViolation[];
  diagnostics: string;
}

function measuredValues(
  samples: readonly SdkFrameSample[],
  key: "fps" | "frameTimeMs" | "jankFrames",
) {
  return samples
    .map((sample) => sample[key])
    .filter((value): value is number => value !== null && Number.isFinite(value));
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  return sorted[Math.ceil((percentile / 100) * sorted.length) - 1] ?? null;
}

function frameMetrics(samples: readonly SdkFrameSample[]): PerformanceMetrics {
  const frameTimes = measuredValues(samples, "frameTimeMs").sort((a, b) => a - b);
  return {
    p50Ms: nearestRank(frameTimes, 50),
    p90Ms: nearestRank(frameTimes, 90),
    p95Ms: nearestRank(frameTimes, 95),
    p99Ms: nearestRank(frameTimes, 99),
    jankCount: mean(measuredValues(samples, "jankFrames")),
    frameRateFps: mean(measuredValues(samples, "fps")),
    missedVsyncCount: null,
    slowUiThreadCount: null,
    frameDeadlineMissedCount: null,
    cpuUsagePercent: null,
    threadCount: null,
    touchLatencyMs: null,
    anrDetected: false,
    anrDetails: null,
    timeToFirstFrameMs: null,
    timeToInteractiveMs: null,
    gfxinfoRaw: null,
    cpuStatsRaw: null,
  };
}

function frameViolations(metrics: PerformanceMetrics): PerformanceViolation[] {
  const { frameTimeWarning, frameTimeCritical, jankWarning, jankCritical } = DEFAULT_THRESHOLDS;
  const frameChecks = [
    { metric: "p50Ms", threshold: frameTimeWarning, severity: "warning", contributionWeight: 0.6 },
    { metric: "p90Ms", threshold: frameTimeWarning, severity: "warning", contributionWeight: 0.7 },
    {
      metric: "p95Ms",
      threshold: frameTimeCritical,
      severity: "critical",
      contributionWeight: 0.8,
    },
    {
      metric: "p99Ms",
      threshold: frameTimeCritical,
      severity: "critical",
      contributionWeight: 0.4,
    },
  ] as const;
  const violations: PerformanceViolation[] = [];
  for (const check of frameChecks) {
    const actual = metrics[check.metric];
    if (actual !== null && actual > check.threshold) {
      violations.push({ ...check, actual });
    }
  }
  const jank = metrics.jankCount;
  if (jank !== null && jank > jankWarning) {
    const critical = jank >= jankCritical;
    violations.push({
      metric: "jankCount",
      threshold: critical ? jankCritical : jankWarning,
      actual: jank,
      severity: critical ? "critical" : "warning",
      contributionWeight: 0.9,
    });
  }
  return violations;
}

export function judgeIosPerformance(
  appId: string,
  samples: readonly SdkFrameSample[],
): OnDemandPerformanceResult | UnsupportedAudit {
  const metrics = frameMetrics(samples);
  if (metrics.p50Ms === null && metrics.jankCount === null && metrics.frameRateFps === null) {
    return {
      unsupported: `No fresh frame metrics from ${appId}: the app must be instrumented with auto-mobile-sdk and in the foreground.`,
    };
  }
  const violations = frameViolations(metrics);
  return {
    passed: violations.length === 0,
    metrics,
    violations,
    diagnostics:
      "Frame-time percentiles are computed over one-second frame-time averages. Touch latency is not measured on iOS Simulator.",
  };
}

export function judgeIosMemory(rssStartKiB: number, rssEndKiB: number): IosMemoryAuditResult {
  const rssStartMb = rssStartKiB / 1024;
  const rssEndMb = rssEndKiB / 1024;
  const rssGrowthMb = rssEndMb - rssStartMb;
  const critical = rssGrowthMb > IOS_RSS_GROWTH_CRITICAL_MB;
  const violations: PerformanceViolation[] = [];
  if (rssGrowthMb > IOS_RSS_GROWTH_WARNING_MB) {
    violations.push({
      metric: "rssGrowth",
      threshold: critical ? IOS_RSS_GROWTH_CRITICAL_MB : IOS_RSS_GROWTH_WARNING_MB,
      actual: rssGrowthMb,
      severity: critical ? "critical" : "warning",
      contributionWeight: 1,
    });
  }
  return {
    passed: violations.length === 0,
    metrics: { rssStartMb, rssEndMb, rssGrowthMb, windowMs: IOS_AUDIT_WINDOW_MS },
    violations,
    diagnostics: "RSS is measured at the start and end of the audit window.",
  };
}
