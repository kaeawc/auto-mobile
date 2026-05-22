import { describe, expect, test } from "bun:test";
import { prettyPrintRunHealth } from "../../../src/features/diagnostics/healthPrettyPrinter";
import type { RunHealthSummary } from "../../../src/features/diagnostics/types";


function makeSummary(overrides: Partial<RunHealthSummary> = {}): RunHealthSummary {
  return {
    sessionId: "test-session",
    planName: "demo-plan",
    startedAt: "2026-05-21T14:00:00.000Z",
    finishedAt: "2026-05-21T14:01:30.000Z",
    durationMs: 90_000,
    device: { id: "emulator-5554", model: "Pixel 8" },
    screenshot: {
      count: 5,
      latencyMs: { count: 5, minMs: 100, p50Ms: 200, p90Ms: 400, p99Ms: 450, maxMs: 500 },
    },
    backStack: {
      count: 2,
      latencyMs: { count: 2, minMs: 50, p50Ms: 60, p90Ms: 70, p99Ms: 70, maxMs: 70 },
    },
    accessibilityDetector: {
      count: 1,
      latencyMs: { count: 1, minMs: 20, p50Ms: 20, p90Ms: 20, p99Ms: 20, maxMs: 20 },
    },
    hierarchy: {
      syncRequests: 10,
      cacheHits: 0,
      freshDeliveries: 8,
      staleCacheReturns: 1,
      timeouts: 1,
      failed: 0,
      cacheHitRate: 0,
      stalenessRate: 0.1,
      freshLatencyMs: { count: 8, minMs: 10, p50Ms: 30, p90Ms: 50, p99Ms: 60, maxMs: 70 },
    },
    awaitIdle: {
      calls: 3,
      timeouts: 1,
      errors: 0,
      timeoutRate: 0.333,
      errorRate: 0,
      durationMs: { count: 3, minMs: 100, p50Ms: 200, p90Ms: 5000, p99Ms: 5000, maxMs: 5000 },
    },
    toolCalls: {
      total: 4,
      successes: 3,
      failures: 1,
      byTool: {
        tapOn: { count: 3, successes: 2, failures: 1, p50Ms: 200, p90Ms: 280, p99Ms: 300, maxMs: 300 },
        observe: { count: 1, successes: 1, failures: 0, p50Ms: 50, p90Ms: 50, p99Ms: 50, maxMs: 50 },
      },
    },
    ghostTap: {
      evaluations: 5,
      tapRegistered: 2,
      falsePositives: 2,
      bailedNullHierarchy: 1,
      falsePositiveRate: 0.4,
    },
    ...overrides,
  };
}


describe("prettyPrintRunHealth", function() {

  test("renders headline metadata", function() {
    const output = prettyPrintRunHealth(makeSummary());
    expect(output).toContain("AutoMobile Run Health Summary");
    expect(output).toContain("Session:     test-session");
    expect(output).toContain("Plan:        demo-plan");
    expect(output).toContain("Duration:    1m 30.0s");
    expect(output).toContain("emulator-5554");
  });


  test("renders tool call breakdown sorted by call count desc", function() {
    const output = prettyPrintRunHealth(makeSummary());
    const tapOnIdx = output.indexOf("tapOn:");
    const observeIdx = output.indexOf("observe:");
    expect(tapOnIdx).toBeGreaterThan(0);
    expect(observeIdx).toBeGreaterThan(0);
    expect(tapOnIdx).toBeLessThan(observeIdx);
  });


  test("renders percentages as 1-decimal", function() {
    const output = prettyPrintRunHealth(makeSummary());
    expect(output).toContain("Staleness rate: 10.0%");
    expect(output).toContain("False-positive rate: 40.0%");
  });


  test("collapses empty latency samples to '(no samples)'", function() {
    const output = prettyPrintRunHealth(
      makeSummary({
        screenshot: {
          count: 0,
          latencyMs: { count: 0, minMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0 },
        },
      })
    );
    expect(output).toContain("(no samples)");
  });


  test("falls back to '(unnamed)' for missing plan name", function() {
    const output = prettyPrintRunHealth(makeSummary({ planName: null }));
    expect(output).toContain("Plan:        (unnamed)");
  });


  test("renders '(ad-hoc)' for null sessionId", function() {
    const output = prettyPrintRunHealth(makeSummary({ sessionId: null }));
    expect(output).toContain("Session:     (ad-hoc)");
  });


  test("renders '(no tool calls recorded)' when there are no tools", function() {
    const output = prettyPrintRunHealth(
      makeSummary({
        toolCalls: { total: 0, successes: 0, failures: 0, byTool: {} },
      })
    );
    expect(output).toContain("(no tool calls recorded)");
  });


  test("hierarchy line surfaces cache hits, failed bucket, and cache hit rate", function() {
    const output = prettyPrintRunHealth(
      makeSummary({
        hierarchy: {
          syncRequests: 8,
          cacheHits: 4,
          freshDeliveries: 1,
          staleCacheReturns: 1,
          timeouts: 0,
          failed: 2,
          cacheHitRate: 0.5,
          stalenessRate: 1 / 8,
          freshLatencyMs: { count: 1, minMs: 10, p50Ms: 10, p90Ms: 10, p99Ms: 10, maxMs: 10 },
        },
      })
    );
    expect(output).toContain("cache=4");
    expect(output).toContain("fresh=1");
    expect(output).toContain("failed=2");
    expect(output).toContain("Cache hit rate: 50.0%");
  });


  test("await idle line surfaces error count and rate separately from timeouts", function() {
    const output = prettyPrintRunHealth(
      makeSummary({
        awaitIdle: {
          calls: 4,
          timeouts: 1,
          errors: 2,
          timeoutRate: 0.25,
          errorRate: 0.5,
          durationMs: { count: 4, minMs: 50, p50Ms: 100, p90Ms: 500, p99Ms: 500, maxMs: 500 },
        },
      })
    );
    expect(output).toContain("timeouts=1");
    expect(output).toContain("errors=2");
    expect(output).toContain("Timeout rate: 25.0%");
    expect(output).toContain("Error rate:   50.0%");
  });
});
