import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THRESHOLDS,
  PerformancePushSocketServer,
  type LivePerformanceData,
} from "../../src/daemon/performancePushSocketServer";

const emptyMetrics: LivePerformanceData["metrics"] = {
  fps: null,
  frameTimeMs: null,
  jankFrames: null,
  touchLatencyMs: null,
  ttffMs: null,
  ttiMs: null,
  cpuUsagePercent: null,
  memoryUsageMb: null,
};

const cases = [
  { key: "fps", warning: 55, critical: 45, direction: -1 },
  { key: "frameTimeMs", warning: 18, critical: 33, direction: 1 },
  { key: "jankFrames", warning: 5, critical: 10, direction: 1 },
  { key: "touchLatencyMs", warning: 100, critical: 200, direction: 1 },
  { key: "ttffMs", warning: 500, critical: 1000, direction: 1 },
  { key: "ttiMs", warning: 700, critical: 1500, direction: 1 },
] as const;

describe("performance health threshold and precedence characterization", () => {
  for (const { key, warning, critical, direction } of cases) {
    test(`${key} uses strict thresholds and ignores null`, () => {
      const health = (value: number | null) =>
        PerformancePushSocketServer.calculateHealth(
          { ...emptyMetrics, [key]: value },
          DEFAULT_THRESHOLDS,
        );
      expect(health(null)).toBe("healthy");
      expect(health(warning)).toBe("healthy");
      expect(health(warning + direction)).toBe("warning");
      expect(health(critical)).toBe("warning");
      expect(health(critical + direction)).toBe("critical");
    });
  }

  for (let index = 0; index < cases.length - 1; index++) {
    const earlier = cases[index];
    const later = cases[index + 1];
    test(`${earlier.key} warning takes precedence over ${later.key} critical`, () => {
      expect(
        PerformancePushSocketServer.calculateHealth(
          {
            ...emptyMetrics,
            [earlier.key]: earlier.warning + earlier.direction,
            [later.key]: later.critical + later.direction,
          },
          DEFAULT_THRESHOLDS,
        ),
      ).toBe("warning");
    });
  }

  test("uses supplied thresholds and ignores CPU and memory", () => {
    expect(
      PerformancePushSocketServer.calculateHealth(
        { ...emptyMetrics, ttiMs: 750, cpuUsagePercent: 100, memoryUsageMb: 9999 },
        { ...DEFAULT_THRESHOLDS, ttiWarning: 800, ttiCritical: 900 },
      ),
    ).toBe("healthy");
  });
});
