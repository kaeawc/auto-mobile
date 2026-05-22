import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { summarizeLatencies } from "./percentile";
import type {
  AwaitIdleOutcome,
  DeviceInfo,
  GhostTapRetryOutcome,
  HierarchyOutcome,
  RunHealthSummary,
  ToolCallStats,
} from "./types";


interface ToolCallSamples {
  successes: number;
  failures: number;
  durations: number[];
}


/**
 * Collects per-plan health metrics in memory and serializes a summary on
 * `finalize()`. One recorder instance per plan execution; the orchestrator
 * brackets the lifetime via `setActiveRecorder` / `clearActiveRecorder`.
 *
 * Hook sites read the current recorder via `getActiveRecorder()` and no-op
 * when no plan is in flight. The recorder is intentionally cheap (counters
 * and arrays only); no I/O until `finalize()`.
 */
export class RunHealthRecorder {

  public readonly sessionId: string | null;

  private planName: string | null;

  private readonly timer: Timer;

  private readonly startedAtMs: number;

  private readonly startedAtIso: string;

  private device: DeviceInfo | null = null;

  private readonly screenshotLatencies: number[] = [];

  private readonly backStackLatencies: number[] = [];

  private readonly accessibilityDetectorLatencies: number[] = [];

  private hierarchyCacheHit = 0;

  private hierarchyFresh = 0;

  private hierarchyStale = 0;

  private hierarchyTimeout = 0;

  private hierarchyFailed = 0;

  private readonly hierarchyFreshLatencies: number[] = [];

  private awaitIdleCalls = 0;

  private awaitIdleTimeouts = 0;

  private awaitIdleErrors = 0;

  private readonly awaitIdleDurations: number[] = [];

  private readonly toolCalls: Map<string, ToolCallSamples> = new Map();

  private ghostTapRegistered = 0;

  private ghostTapFalsePositives = 0;

  private ghostTapBailedNull = 0;


  constructor(
    options: {
      sessionId: string | null;
      planName?: string | null;
      timer?: Timer;
    }
  ) {
    this.sessionId = options.sessionId;
    this.planName = options.planName ?? null;
    this.timer = options.timer ?? defaultTimer;
    this.startedAtMs = this.timer.now();
    this.startedAtIso = new Date(this.startedAtMs).toISOString();
  }


  setDevice(device: DeviceInfo | null): void {
    this.device = device;
  }


  setPlanName(planName: string | null): void {
    this.planName = planName;
  }


  recordScreenshot(durationMs: number): void {
    this.screenshotLatencies.push(durationMs);
  }


  recordBackStack(durationMs: number): void {
    this.backStackLatencies.push(durationMs);
  }


  recordAccessibilityDetection(durationMs: number): void {
    this.accessibilityDetectorLatencies.push(durationMs);
  }


  recordHierarchy(outcome: HierarchyOutcome, freshLatencyMs?: number): void {
    switch (outcome) {
      case "cache-hit":
        this.hierarchyCacheHit++;
        break;
      case "fresh":
        this.hierarchyFresh++;
        if (freshLatencyMs !== undefined) {
          this.hierarchyFreshLatencies.push(freshLatencyMs);
        }
        break;
      case "stale":
        this.hierarchyStale++;
        break;
      case "timeout":
        this.hierarchyTimeout++;
        break;
      case "failed":
        this.hierarchyFailed++;
        break;
    }
  }


  recordAwaitIdle(outcome: AwaitIdleOutcome, durationMs: number): void {
    this.awaitIdleCalls++;
    this.awaitIdleDurations.push(durationMs);
    switch (outcome) {
      case "timeout":
        this.awaitIdleTimeouts++;
        break;
      case "error":
        this.awaitIdleErrors++;
        break;
      case "settled":
        break;
    }
  }


  recordToolCall(toolName: string, durationMs: number, success: boolean): void {
    const existing = this.toolCalls.get(toolName) ?? {
      successes: 0,
      failures: 0,
      durations: [],
    };
    existing.durations.push(durationMs);
    if (success) {
      existing.successes++;
    } else {
      existing.failures++;
    }
    this.toolCalls.set(toolName, existing);
  }


  recordGhostTapRetry(outcome: GhostTapRetryOutcome): void {
    switch (outcome) {
      case "tap-registered":
        this.ghostTapRegistered++;
        break;
      case "false-positive":
        this.ghostTapFalsePositives++;
        break;
      case "bailed-null-hierarchy":
        this.ghostTapBailedNull++;
        break;
    }
  }


  finalize(): RunHealthSummary {
    const finishedAtMs = this.timer.now();
    const finishedAtIso = new Date(finishedAtMs).toISOString();

    const byTool: Record<string, ToolCallStats> = {};
    let totalCalls = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;
    for (const [name, samples] of this.toolCalls.entries()) {
      const latency = summarizeLatencies(samples.durations);
      byTool[name] = {
        count: samples.successes + samples.failures,
        successes: samples.successes,
        failures: samples.failures,
        p50Ms: latency.p50Ms,
        p90Ms: latency.p90Ms,
        p99Ms: latency.p99Ms,
        maxMs: latency.maxMs,
      };
      totalCalls += samples.successes + samples.failures;
      totalSuccesses += samples.successes;
      totalFailures += samples.failures;
    }

    const hierarchyTotal =
      this.hierarchyCacheHit +
      this.hierarchyFresh +
      this.hierarchyStale +
      this.hierarchyTimeout +
      this.hierarchyFailed;
    const ghostTapEvaluations =
      this.ghostTapRegistered +
      this.ghostTapFalsePositives +
      this.ghostTapBailedNull;

    return {
      sessionId: this.sessionId,
      planName: this.planName,
      startedAt: this.startedAtIso,
      finishedAt: finishedAtIso,
      durationMs: finishedAtMs - this.startedAtMs,
      device: this.device,
      screenshot: {
        count: this.screenshotLatencies.length,
        latencyMs: summarizeLatencies(this.screenshotLatencies),
      },
      backStack: {
        count: this.backStackLatencies.length,
        latencyMs: summarizeLatencies(this.backStackLatencies),
      },
      accessibilityDetector: {
        count: this.accessibilityDetectorLatencies.length,
        latencyMs: summarizeLatencies(this.accessibilityDetectorLatencies),
      },
      hierarchy: {
        syncRequests: hierarchyTotal,
        cacheHits: this.hierarchyCacheHit,
        freshDeliveries: this.hierarchyFresh,
        staleCacheReturns: this.hierarchyStale,
        timeouts: this.hierarchyTimeout,
        failed: this.hierarchyFailed,
        cacheHitRate: hierarchyTotal === 0 ? 0 : this.hierarchyCacheHit / hierarchyTotal,
        stalenessRate: hierarchyTotal === 0 ? 0 : this.hierarchyStale / hierarchyTotal,
        freshLatencyMs: summarizeLatencies(this.hierarchyFreshLatencies),
      },
      awaitIdle: {
        calls: this.awaitIdleCalls,
        timeouts: this.awaitIdleTimeouts,
        errors: this.awaitIdleErrors,
        timeoutRate: this.awaitIdleCalls === 0 ? 0 : this.awaitIdleTimeouts / this.awaitIdleCalls,
        errorRate: this.awaitIdleCalls === 0 ? 0 : this.awaitIdleErrors / this.awaitIdleCalls,
        durationMs: summarizeLatencies(this.awaitIdleDurations),
      },
      toolCalls: {
        total: totalCalls,
        successes: totalSuccesses,
        failures: totalFailures,
        byTool,
      },
      ghostTap: {
        evaluations: ghostTapEvaluations,
        tapRegistered: this.ghostTapRegistered,
        falsePositives: this.ghostTapFalsePositives,
        bailedNullHierarchy: this.ghostTapBailedNull,
        falsePositiveRate:
          ghostTapEvaluations === 0
            ? 0
            : this.ghostTapFalsePositives / ghostTapEvaluations,
      },
    };
  }
}


// --- Active-recorder registry ---------------------------------------------
//
// The orchestrator installs a recorder for the duration of a plan execution.
// Hook sites read via `getActiveRecorder()` so they don't need to plumb the
// session/recorder reference through every call frame.
//
// Concurrency: only one recorder can be active at a time. Concurrent plans on
// different sessions will not be cleanly partitioned — the most recently
// installed recorder receives events while it is active. `setActiveRecorder`
// emits a warn when it overwrites a different active recorder so the case is
// visible in logs. The `PlanExecutionOrchestrator.execute()` finally block
// guarantees `clearActiveRecorder` runs on every path, so an overwrite at
// runtime means two orchestrators ran concurrently (not "someone forgot to
// clear" — that path is structurally impossible given the finally bracket).
//
// Structural fix (future): swap this flat singleton for an AsyncLocalStorage
// context so each plan's async chain carries its own recorder reference. That
// removes the overwrite scenario entirely — there is no shared slot to clobber.

let activeRecorder: RunHealthRecorder | null = null;


export function setActiveRecorder(recorder: RunHealthRecorder): void {
  if (activeRecorder !== null && activeRecorder !== recorder) {
    logger.warn(
      `[HEALTH] Concurrent plan execution detected: setActiveRecorder called ` +
      `while another recorder is still active. ` +
      `previous=${activeRecorder.sessionId ?? "(ad-hoc)"}, new=${recorder.sessionId ?? "(ad-hoc)"}. ` +
      `Events fired during the overlap will be attributed to the new recorder; ` +
      `the previous summary may undercount.`
    );
  }
  activeRecorder = recorder;
}


export function clearActiveRecorder(recorder: RunHealthRecorder): void {
  if (activeRecorder === recorder) {
    activeRecorder = null;
  }
}


export function getActiveRecorder(): RunHealthRecorder | null {
  return activeRecorder;
}


/** Test-only helper for guaranteeing clean state between cases. */
export function __resetActiveRecorderForTests(): void {
  activeRecorder = null;
}
