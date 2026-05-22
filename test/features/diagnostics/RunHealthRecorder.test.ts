import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  RunHealthRecorder,
  __resetActiveRecorderForTests,
  clearActiveRecorder,
  getActiveRecorder,
  setActiveRecorder,
} from "../../../src/features/diagnostics/RunHealthRecorder";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";


function makeRecorder(timer: FakeTimer, sessionId = "s1", planName: string | null = "test-plan") {
  return new RunHealthRecorder({ sessionId, planName, timer });
}


describe("RunHealthRecorder", function() {

  beforeEach(function() {
    __resetActiveRecorderForTests();
  });


  afterEach(function() {
    __resetActiveRecorderForTests();
  });


  test("finalize returns a self-describing summary with zero counts when nothing was recorded", function() {
    const timer = new FakeTimer();
    const recorder = makeRecorder(timer);
    timer.advanceTime(5);

    const summary = recorder.finalize();

    expect(summary.sessionId).toBe("s1");
    expect(summary.planName).toBe("test-plan");
    expect(summary.durationMs).toBe(5);
    expect(summary.toolCalls.total).toBe(0);
    expect(summary.hierarchy.syncRequests).toBe(0);
    expect(summary.hierarchy.cacheHitRate).toBe(0);
    expect(summary.hierarchy.stalenessRate).toBe(0);
    expect(summary.awaitIdle.calls).toBe(0);
    expect(summary.awaitIdle.errorRate).toBe(0);
    expect(summary.ghostTap.evaluations).toBe(0);
    expect(summary.screenshot.count).toBe(0);
  });


  test("screenshot recording aggregates count and latency percentiles", function() {
    const timer = new FakeTimer();
    const recorder = makeRecorder(timer);

    recorder.recordScreenshot(100);
    recorder.recordScreenshot(200);
    recorder.recordScreenshot(50);

    const summary = recorder.finalize();
    expect(summary.screenshot.count).toBe(3);
    expect(summary.screenshot.latencyMs.minMs).toBe(50);
    expect(summary.screenshot.latencyMs.maxMs).toBe(200);
  });


  test("sessionId can be null for ad-hoc runs", function() {
    const timer = new FakeTimer();
    const recorder = new RunHealthRecorder({ sessionId: null, timer });
    const summary = recorder.finalize();
    expect(summary.sessionId).toBeNull();
  });


  test("hierarchy cache-hit/fresh/stale/timeout/failed counters and derived rates", function() {
    const timer = new FakeTimer();
    const recorder = makeRecorder(timer);

    recorder.recordHierarchy("cache-hit");
    recorder.recordHierarchy("cache-hit");
    recorder.recordHierarchy("fresh", 30);
    recorder.recordHierarchy("fresh", 40);
    recorder.recordHierarchy("stale");
    recorder.recordHierarchy("timeout");
    recorder.recordHierarchy("failed");

    const summary = recorder.finalize();
    expect(summary.hierarchy.syncRequests).toBe(7);
    expect(summary.hierarchy.cacheHits).toBe(2);
    expect(summary.hierarchy.freshDeliveries).toBe(2);
    expect(summary.hierarchy.staleCacheReturns).toBe(1);
    expect(summary.hierarchy.timeouts).toBe(1);
    expect(summary.hierarchy.failed).toBe(1);
    expect(summary.hierarchy.cacheHitRate).toBeCloseTo(2 / 7, 3);
    expect(summary.hierarchy.stalenessRate).toBeCloseTo(1 / 7, 3);
    expect(summary.hierarchy.freshLatencyMs.count).toBe(2);
  });


  test("cache-hit calls do not contribute to fresh latency samples", function() {
    const timer = new FakeTimer();
    const recorder = makeRecorder(timer);

    recorder.recordHierarchy("cache-hit");
    recorder.recordHierarchy("cache-hit");
    recorder.recordHierarchy("fresh", 100);

    const summary = recorder.finalize();
    expect(summary.hierarchy.freshLatencyMs.count).toBe(1);
    expect(summary.hierarchy.freshLatencyMs.maxMs).toBe(100);
  });


  test("await idle separates settled/timeout/error into timeoutRate and errorRate", function() {
    const timer = new FakeTimer();
    const recorder = makeRecorder(timer);

    recorder.recordAwaitIdle("settled", 100);
    recorder.recordAwaitIdle("settled", 200);
    recorder.recordAwaitIdle("timeout", 5000);
    recorder.recordAwaitIdle("error", 1500);

    const summary = recorder.finalize();
    expect(summary.awaitIdle.calls).toBe(4);
    expect(summary.awaitIdle.timeouts).toBe(1);
    expect(summary.awaitIdle.errors).toBe(1);
    expect(summary.awaitIdle.timeoutRate).toBeCloseTo(0.25, 2);
    expect(summary.awaitIdle.errorRate).toBeCloseTo(0.25, 2);
    expect(summary.awaitIdle.durationMs.count).toBe(4);
    expect(summary.awaitIdle.durationMs.maxMs).toBe(5000);
  });


  test("tool call recording aggregates per-tool counts, successes, failures, and percentiles", function() {
    const timer = new FakeTimer();
    const recorder = makeRecorder(timer);

    recorder.recordToolCall("tapOn", 100, true);
    recorder.recordToolCall("tapOn", 200, true);
    recorder.recordToolCall("tapOn", 300, false);
    recorder.recordToolCall("observe", 50, true);

    const summary = recorder.finalize();
    expect(summary.toolCalls.total).toBe(4);
    expect(summary.toolCalls.successes).toBe(3);
    expect(summary.toolCalls.failures).toBe(1);

    expect(summary.toolCalls.byTool.tapOn.count).toBe(3);
    expect(summary.toolCalls.byTool.tapOn.successes).toBe(2);
    expect(summary.toolCalls.byTool.tapOn.failures).toBe(1);
    expect(summary.toolCalls.byTool.tapOn.maxMs).toBe(300);

    expect(summary.toolCalls.byTool.observe.count).toBe(1);
  });


  test("ghost tap retry counters and false-positive rate", function() {
    const timer = new FakeTimer();
    const recorder = makeRecorder(timer);

    recorder.recordGhostTapRetry("tap-registered");
    recorder.recordGhostTapRetry("tap-registered");
    recorder.recordGhostTapRetry("false-positive");
    recorder.recordGhostTapRetry("false-positive");
    recorder.recordGhostTapRetry("bailed-null-hierarchy");

    const summary = recorder.finalize();
    expect(summary.ghostTap.evaluations).toBe(5);
    expect(summary.ghostTap.tapRegistered).toBe(2);
    expect(summary.ghostTap.falsePositives).toBe(2);
    expect(summary.ghostTap.bailedNullHierarchy).toBe(1);
    expect(summary.ghostTap.falsePositiveRate).toBeCloseTo(0.4, 2);
  });


  test("device info appears in finalize output", function() {
    const timer = new FakeTimer();
    const recorder = makeRecorder(timer);

    recorder.setDevice({ id: "emulator-5554", model: "Pixel 8" });

    const summary = recorder.finalize();
    expect(summary.device).toEqual({ id: "emulator-5554", model: "Pixel 8" });
  });


  test("active-recorder registry: set, get, clear", function() {
    const timer = new FakeTimer();
    const recorder = makeRecorder(timer);

    expect(getActiveRecorder()).toBeNull();

    setActiveRecorder(recorder);
    expect(getActiveRecorder()).toBe(recorder);

    clearActiveRecorder(recorder);
    expect(getActiveRecorder()).toBeNull();
  });


  test("clearActiveRecorder no-ops if a different recorder is active (concurrent-plan safety)", function() {
    const timer = new FakeTimer();
    const r1 = makeRecorder(timer, "s1");
    const r2 = makeRecorder(timer, "s2");

    setActiveRecorder(r1);
    setActiveRecorder(r2);

    clearActiveRecorder(r1);

    expect(getActiveRecorder()).toBe(r2);
  });


  test("setActiveRecorder warns when overwriting a different active recorder", function() {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    const timer = new FakeTimer();
    const r1 = makeRecorder(timer, "s1");
    const r2 = makeRecorder(timer, "s2");

    setActiveRecorder(r1);
    setActiveRecorder(r2);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("Concurrent plan execution detected");

    warnSpy.mockRestore();
  });
});
