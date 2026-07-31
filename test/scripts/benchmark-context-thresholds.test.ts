import { describe, expect, test } from "bun:test";
import {
  evaluateMeasurements,
  type ContextMeasurements,
  type ThresholdConfig,
} from "../../scripts/benchmark-context-thresholds";

const measurements: ContextMeasurements = {
  coreTools: 100,
  allTools: 300,
  resources: 20,
  resourceTemplates: 40,
  coreTotal: 160,
  allTotal: 360,
};

function config(thresholds?: ContextMeasurements): ThresholdConfig {
  return {
    version: "2.0.0",
    metadata: { baseline: measurements },
    ...(thresholds === undefined ? {} : { thresholds }),
  };
}

describe("context baseline benchmark", () => {
  test("reports both profiles against their baselines without enforcing a limit", () => {
    const report = evaluateMeasurements(
      { ...measurements, coreTools: 105, coreTotal: 165 },
      config(),
    );

    expect(report).toMatchObject({
      passed: true,
      enforcement: { enabled: false },
      baselines: measurements,
      violations: [],
    });
    expect(report.results.coreTools).toEqual({ actual: 105, baseline: 100, delta: 5 });
    expect(report.results.allTools).toEqual({ actual: 300, baseline: 300, delta: 0 });
  });

  test("enforces every profile measurement once limits are configured", () => {
    const report = evaluateMeasurements(
      { ...measurements, allTools: 301, allTotal: 361 },
      config(measurements),
    );

    expect(report.enforcement.enabled).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.results.coreTools).toMatchObject({ threshold: 100, passed: true, usage: 100 });
    expect(report.results.allTools).toMatchObject({ threshold: 300, passed: false, usage: 100 });
    expect(report.violations).toEqual([
      "allTools: 301 tokens exceeds threshold of 300 tokens",
      "allTotal: 361 tokens exceeds threshold of 360 tokens",
    ]);
  });
});
