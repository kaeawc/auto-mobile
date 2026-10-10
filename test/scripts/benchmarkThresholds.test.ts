import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_BATCH_SIZE,
  THRESHOLD_FLOOR_MS,
  TARGET_SAMPLE_MS,
  chooseBatchSize,
  compareAgainstThreshold,
  effectiveThreshold,
} from "../../scripts/benchmark-thresholds";

const tiny = { p50: 0.1, p95: 0.2, mean: 0.1 };

describe("benchmark threshold floor", () => {
  test("raises sub-floor thresholds to the per-metric floor", () => {
    expect(effectiveThreshold("p50", 0.1)).toBe(THRESHOLD_FLOOR_MS.p50);
    expect(effectiveThreshold("p95", 0.7)).toBe(THRESHOLD_FLOOR_MS.p95);
    expect(effectiveThreshold("mean", 0.5)).toBe(THRESHOLD_FLOOR_MS.mean);
  });

  test("leaves thresholds above the floor untouched", () => {
    expect(effectiveThreshold("p95", 49.8)).toBe(49.8);
  });

  test("a sub-ms threshold does not fail on a 3x noisy sample or sit exactly at threshold", () => {
    const checks = compareAgainstThreshold({ p50: 0.3, p95: 0.6, mean: 0.5 }, tiny);
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  test("passes up to 20% over the floored threshold and fails beyond it", () => {
    const atLimit = compareAgainstThreshold({ p50: 1.2, p95: 6, mean: 1.2 }, tiny);
    expect(atLimit.every((c) => c.passed)).toBe(true);
    const over = compareAgainstThreshold({ p50: 1.3, p95: 5.0, mean: 1.0 }, tiny);
    expect(over.map((c) => c.passed)).toEqual([false, true, true]);
    expect(over[0].threshold).toBe(1);
  });

  test("still catches a process-spawn-sized regression on a fake-backed tool", () => {
    const checks = compareAgainstThreshold({ p50: 25, p95: 40, mean: 28 }, tiny);
    expect(checks.every((c) => !c.passed)).toBe(true);
  });

  test("every configured threshold is at or above its floor", () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../scripts/tool-thresholds.json"), "utf-8"),
    ) as { thresholds: Record<string, Record<"p50" | "p95" | "mean", number>> };
    for (const [tool, t] of Object.entries(config.thresholds)) {
      for (const metric of ["p50", "p95", "mean"] as const) {
        expect(`${tool}.${metric}=${t[metric] >= THRESHOLD_FLOOR_MS[metric]}`).toBe(
          `${tool}.${metric}=true`,
        );
      }
    }
  });
});

describe("benchmark batch sizing", () => {
  test("sizes a batch to about the target sample time", () => {
    expect(chooseBatchSize(0.05)).toBe(Math.ceil(TARGET_SAMPLE_MS / 0.05));
  });

  test("handlers slower than the target are not batched", () => {
    expect(chooseBatchSize(7)).toBe(1);
  });

  test("a zero or invalid estimate uses the cap", () => {
    expect(chooseBatchSize(0)).toBe(MAX_BATCH_SIZE);
    expect(chooseBatchSize(Number.NaN)).toBe(MAX_BATCH_SIZE);
    expect(chooseBatchSize(0.0001)).toBe(MAX_BATCH_SIZE);
  });
});
