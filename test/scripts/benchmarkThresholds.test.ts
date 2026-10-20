import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_BATCH_SIZE,
  MAX_REMEASURES,
  THRESHOLD_FLOOR_MS,
  TARGET_SAMPLE_MS,
  chooseBatchSize,
  compareAgainstThreshold,
  effectiveThreshold,
  judgeWithRemeasure,
} from "../../scripts/benchmark-thresholds";

const tiny = { p50: 0.1, p95: 0.2, mean: 0.1 };

describe("re-measure decision", () => {
  const threshold = { p50: 17.5, p95: 49.8, mean: 22.3 };
  const passing = { p50: 8, p95: 14, mean: 9 };
  const tripping = { p50: 23.4, p95: 30, mean: 20 };

  test("does not re-measure a passing first sample", async () => {
    let calls = 0;
    const decision = await judgeWithRemeasure(passing, threshold, async () => {
      calls++;
      return tripping;
    });
    expect(decision.passed).toBe(true);
    expect(decision.remeasured).toBe(false);
    expect(calls).toBe(0);
    expect(decision.second).toBeUndefined();
    expect(decision.first.metrics).toBe(passing);
    expect(decision.deciding).toBe(decision.first);
  });

  test("passes when the second sample passes and retains the failed first sample", async () => {
    let calls = 0;
    const decision = await judgeWithRemeasure(tripping, threshold, async () => {
      calls++;
      return passing;
    });
    expect(decision.passed).toBe(true);
    expect(decision.remeasured).toBe(true);
    expect(calls).toBe(1);
    expect(decision.first.metrics).toBe(tripping);
    expect(decision.first.passed).toBe(false);
    expect(decision.first.checks[0]).toMatchObject({ metric: "p50", actual: 23.4, passed: false });
    expect(decision.second?.metrics).toBe(passing);
    expect(decision.second?.passed).toBe(true);
    expect(decision.second?.checks.every((check) => check.passed)).toBe(true);
    if (!decision.second) {
      throw new Error("Expected second measurement");
    }
    expect(decision.deciding).toBe(decision.second);
  });

  test("fails when both samples trip and retains each sample's values and checks", async () => {
    let calls = 0;
    const second = { p50: 24.1, p95: 65, mean: 28 };
    const decision = await judgeWithRemeasure(tripping, threshold, async () => {
      calls++;
      return second;
    });
    expect(decision.passed).toBe(false);
    expect(decision.remeasured).toBe(true);
    expect(calls).toBe(1);
    expect(decision.first.metrics).toBe(tripping);
    expect(decision.first.passed).toBe(false);
    expect(decision.first.checks[0]).toMatchObject({ metric: "p50", actual: 23.4, passed: false });
    expect(decision.second?.metrics).toBe(second);
    expect(decision.second?.passed).toBe(false);
    expect(decision.second?.checks.map((check) => check.actual)).toEqual([24.1, 65, 28]);
    expect(decision.second?.checks.every((check) => !check.passed)).toBe(true);
    if (!decision.second) {
      throw new Error("Expected second measurement");
    }
    expect(decision.deciding).toBe(decision.second);
  });

  test("takes at most one re-measure even when every sample trips", async () => {
    let calls = 0;
    const decision = await judgeWithRemeasure(tripping, threshold, async () => {
      calls++;
      return tripping;
    });
    expect(MAX_REMEASURES).toBe(1);
    expect(calls).toBe(MAX_REMEASURES);
    expect(decision.passed).toBe(false);
    expect(decision.remeasured).toBe(true);
  });

  test("does not re-measure or enforce a missing threshold", async () => {
    let calls = 0;
    const slow = { p50: 10000, p95: 20000, mean: 15000 };
    const decision = await judgeWithRemeasure(slow, undefined, async () => {
      calls++;
      return passing;
    });
    expect(decision.passed).toBe(true);
    expect(decision.remeasured).toBe(false);
    expect(calls).toBe(0);
    expect(decision.first.metrics).toBe(slow);
    expect(decision.first.checks).toEqual([]);
    expect(decision.first.passed).toBe(true);
    expect(decision.second).toBeUndefined();
    expect(decision.deciding).toBe(decision.first);
  });

  test("does not re-measure exactly 20% over the threshold", async () => {
    let calls = 0;
    const decision = await judgeWithRemeasure({ ...passing, p50: 21 }, threshold, async () => {
      calls++;
      return tripping;
    });
    expect(decision.first.checks[0].regression).toBe(20);
    expect(decision.passed).toBe(true);
    expect(decision.remeasured).toBe(false);
    expect(calls).toBe(0);
    expect(decision.second).toBeUndefined();
    expect(decision.deciding).toBe(decision.first);
  });

  test("propagates a rejected re-measure", async () => {
    let calls = 0;
    const error = new Error("Re-measure failed");
    const decision = judgeWithRemeasure(tripping, threshold, async () => {
      calls++;
      throw error;
    });
    await expect(decision).rejects.toBe(error);
    expect(calls).toBe(1);
  });
});

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
