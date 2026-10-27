import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FleetSettleDetector,
  TEMPLATE_CPU_MEAN_WINDOW_MS,
  TEMPLATE_CPU_THRESHOLD_PERCENT,
  TEMPLATE_MAX_WAIT_MS,
  TEMPLATE_QUIET_WINDOW_MS,
} from "../../../src/features/iosTemplates/SettleDetector";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { FleetCostSource } from "../../../src/features/iosSimFleet/FleetCostCollector";
function source(cpus: (number | undefined)[]): Pick<FleetCostSource, "collectFresh"> {
  return {
    collectFresh: async () => {
      const cpu = cpus.shift();
      return {
        collectedAtMs: 0,
        errors: [],
        totals: {
          bootedCount: 1,
          measuredCount: 1,
          rssBytes: 0,
          diskBytes: 0,
          cpuPercent: cpu ?? 0,
        },
        simulators: [
          {
            udid: "template",
            name: "template",
            runtime: "ios",
            state: "Booted",
            quality: cpu === undefined ? "unavailable" : "measured",
            process:
              cpu === undefined ? undefined : { cpuPercent: cpu, rssBytes: 0, processCount: 1 },
          },
        ],
      };
    },
  };
}
test("quiet window resets on CPU spike and missing telemetry", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const detector = new FleetSettleDetector(source([0, 0, 10, undefined, 0, 0, 0]), timer, 10);
  await detector.waitUntilSettled("template", {
    quietWindowMs: 20,
    cpuThresholdPercent: 5,
    maxWaitMs: 100,
  });
  expect(timer.now()).toBe(60);
});
test("timeout never produces a settled template", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  await expect(
    new FleetSettleDetector(source([10, 10, 10]), timer, 10).waitUntilSettled("template", {
      quietWindowMs: 20,
      cpuThresholdPercent: 5,
      maxWaitMs: 20,
    }),
  ).rejects.toThrow("settle");
});

// #15294: a quiet host held a booted template at a steady ~10% of one core (pairedsyncd, a 1-20%
// sawtooth every 5 s) from t=540 s to 915 s. The old 5% instantaneous criterion reset on every
// other sample, so the build failed "did not settle" after 917 s. Captured samples (6 minutes).
const STEADY = readFileSync(
  join(import.meta.dir, "../../fixtures/ios-templates/settle-cpu-steady-background-r6.csv"),
  "utf8",
)
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => Number(line.split(",")[1]));

test("the captured steady background load settles with the production criterion", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const detector = new FleetSettleDetector(source([...STEADY]), timer, 5_000);
  await detector.waitUntilSettled("template", {
    quietWindowMs: TEMPLATE_QUIET_WINDOW_MS,
    cpuThresholdPercent: TEMPLATE_CPU_THRESHOLD_PERCENT,
    cpuMeanWindowMs: TEMPLATE_CPU_MEAN_WINDOW_MS,
    maxWaitMs: TEMPLATE_MAX_WAIT_MS,
  });
  expect(timer.now()).toBeLessThan(TEMPLATE_QUIET_WINDOW_MS + 15_000);
});

test("the same load never settled under the old 5% instantaneous criterion", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  await expect(
    new FleetSettleDetector(source([...STEADY]), timer, 5_000).waitUntilSettled("template", {
      quietWindowMs: TEMPLATE_QUIET_WINDOW_MS,
      cpuThresholdPercent: 5,
      maxWaitMs: 300_000,
    }),
  ).rejects.toThrow("settle");
});

test("a sustained busy period is still not settled by the trailing mean", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  await expect(
    new FleetSettleDetector(source(Array(60).fill(60)), timer, 5_000).waitUntilSettled("template", {
      quietWindowMs: TEMPLATE_QUIET_WINDOW_MS,
      cpuThresholdPercent: TEMPLATE_CPU_THRESHOLD_PERCENT,
      cpuMeanWindowMs: TEMPLATE_CPU_MEAN_WINDOW_MS,
      maxWaitMs: 200_000,
    }),
  ).rejects.toThrow("settle");
});
