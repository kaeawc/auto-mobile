import { expect, test } from "bun:test";
import { FleetSettleDetector } from "../../../src/features/iosTemplates/SettleDetector";
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
