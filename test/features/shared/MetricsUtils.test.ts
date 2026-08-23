import { describe, it, expect } from "bun:test";
import {
  adjustWeight,
  calculateWeightedAverage,
  calculateWeightedAverages,
  exponentialMovingAverage,
  calculateMode,
  calculateMedian,
  safeDivide,
  getCutoffDate,
} from "../../../src/features/shared/MetricsUtils";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("MetricsUtils", () => {
  describe("adjustWeight", () => {
    it("increases weight by 10% on success", () => {
      expect(adjustWeight(1.0, true)).toBeCloseTo(1.1);
      expect(adjustWeight(0.5, true)).toBeCloseTo(0.55);
    });

    it("decreases weight by 10% on failure", () => {
      expect(adjustWeight(1.0, false)).toBeCloseTo(0.9);
      expect(adjustWeight(0.5, false)).toBeCloseTo(0.45);
    });

    it("caps weight at maximum 2.0", () => {
      expect(adjustWeight(1.9, true)).toBeCloseTo(2.0);
      expect(adjustWeight(2.0, true)).toBe(2.0);
    });

    it("floors weight at minimum 0.1", () => {
      expect(adjustWeight(0.11, false)).toBeCloseTo(0.1);
      expect(adjustWeight(0.1, false)).toBe(0.1);
    });
  });

  describe("calculateWeightedAverage", () => {
    interface TestItem {
      value: number;
      weight: number;
    }

    it("calculates weighted average correctly", () => {
      const items: TestItem[] = [
        { value: 10, weight: 1 },
        { value: 20, weight: 1 },
      ];
      const avg = calculateWeightedAverage(
        items,
        (i) => i.value,
        (i) => i.weight,
      );
      expect(avg).toBe(15);
    });

    it("applies weights correctly", () => {
      const items: TestItem[] = [
        { value: 10, weight: 3 },
        { value: 20, weight: 1 },
      ];
      // (10*3 + 20*1) / (3+1) = 50/4 = 12.5
      const avg = calculateWeightedAverage(
        items,
        (i) => i.value,
        (i) => i.weight,
      );
      expect(avg).toBe(12.5);
    });

    it("returns null for empty array", () => {
      const avg = calculateWeightedAverage(
        [],
        (i: TestItem) => i.value,
        (i: TestItem) => i.weight,
      );
      expect(avg).toBeNull();
    });

    it("returns null when total weight is zero", () => {
      const items: TestItem[] = [
        { value: 10, weight: 0 },
        { value: 20, weight: 0 },
      ];
      const avg = calculateWeightedAverage(
        items,
        (i) => i.value,
        (i) => i.weight,
      );
      expect(avg).toBeNull();
    });
  });

  describe("calculateWeightedAverages", () => {
    interface TestData {
      a: number;
      b: number;
      weight: number;
    }

    it("calculates multiple weighted averages", () => {
      const items: TestData[] = [
        { a: 10, b: 100, weight: 1 },
        { a: 20, b: 200, weight: 1 },
      ];

      const result = calculateWeightedAverages(
        items,
        [
          { key: "avgA", getValue: (i) => i.a },
          { key: "avgB", getValue: (i) => i.b },
        ],
        (i) => i.weight,
      );

      expect(result).toEqual({ avgA: 15, avgB: 150 });
    });

    it("rounds values when specified", () => {
      const items: TestData[] = [
        { a: 10, b: 100, weight: 1 },
        { a: 15, b: 150, weight: 1 },
      ];

      const result = calculateWeightedAverages(
        items,
        [
          { key: "avgA", getValue: (i) => i.a, round: true },
          { key: "avgB", getValue: (i) => i.b },
        ],
        (i) => i.weight,
      );

      expect(result).toEqual({ avgA: 13, avgB: 125 }); // 12.5 rounded to 13
    });

    it("returns null for empty array", () => {
      const result = calculateWeightedAverages(
        [] as TestData[],
        [{ key: "avgA", getValue: (i) => i.a }],
        (i) => i.weight,
      );
      expect(result).toBeNull();
    });
  });

  describe("exponentialMovingAverage", () => {
    it("calculates EMA with default alpha", () => {
      // 0.3 * 100 + 0.7 * 50 = 30 + 35 = 65
      const ema = exponentialMovingAverage(50, 100);
      expect(ema).toBeCloseTo(65);
    });

    it("calculates EMA with custom alpha", () => {
      // 0.5 * 100 + 0.5 * 50 = 75
      const ema = exponentialMovingAverage(50, 100, 0.5);
      expect(ema).toBe(75);
    });

    it("with alpha=1, returns new value", () => {
      expect(exponentialMovingAverage(50, 100, 1)).toBe(100);
    });

    it("with alpha=0, returns old value", () => {
      expect(exponentialMovingAverage(50, 100, 0)).toBe(50);
    });
  });

  describe("calculateMode", () => {
    it("returns most frequent value", () => {
      expect(calculateMode([60, 60, 60, 90, 120])).toBe(60);
    });

    it("handles single value", () => {
      expect(calculateMode([60])).toBe(60);
    });

    it("returns the value that first reaches the max count on a tie", () => {
      // Tie-break is deterministic: 60 reaches count 2 before 90 does.
      expect(calculateMode([60, 90, 60, 90])).toBe(60);
    });

    it("returns the other tied value when it reaches the max count first", () => {
      expect(calculateMode([90, 60, 90, 60])).toBe(90);
    });

    it("returns undefined for empty array", () => {
      expect(calculateMode([])).toBeUndefined();
    });
  });

  describe("calculateMedian", () => {
    const cases: Array<[string, number[], number | undefined]> = [
      ["returns the middle value for an odd-length sample", [30, 10, 20], 20],
      ["averages the two central values for an even-length sample", [10, 20, 30, 40], 25],
      ["returns the single value for a one-element sample", [42], 42],
      ["returns undefined for an empty sample", [], undefined],
      ["handles an unsorted even sample", [40, 10, 30, 20], 25],
      ["handles duplicate values", [5, 5, 5, 5], 5],
      ["handles negative values", [-10, -30, -20], -20],
    ];
    it.each(cases)("%s", (_name, values, expected) => {
      expect(calculateMedian(values)).toBe(expected);
    });

    it("does not mutate the caller's array", () => {
      const values = [30, 10, 20];
      calculateMedian(values);
      expect(values).toEqual([30, 10, 20]);
    });
  });

  describe("safeDivide", () => {
    it("returns ratio for normal division", () => {
      expect(safeDivide(100, 50)).toBe(2);
      expect(safeDivide(25, 100)).toBe(0.25);
    });

    it("returns Infinity when baseline is 0 and current > 0", () => {
      expect(safeDivide(100, 0)).toBe(Infinity);
    });

    it("returns 1.0 when both are 0", () => {
      expect(safeDivide(0, 0)).toBe(1.0);
    });

    const boundaryCases: Array<[string, number, number, number]> = [
      ["negative current over zero baseline collapses to 1.0", -5, 0, 1.0],
      ["negative-zero baseline is treated as zero", 5, -0, Infinity],
      ["zero current over zero baseline is 1.0", 0, 0, 1.0],
      ["negative over negative is a positive ratio", -10, -2, 5],
      ["negative over positive is a negative ratio", -10, 2, -5],
    ];
    it.each(boundaryCases)("%s", (_name, current, baseline, expected) => {
      expect(safeDivide(current, baseline)).toBe(expected);
    });

    it("propagates NaN through a normal division", () => {
      expect(safeDivide(NaN, 5)).toBeNaN();
    });
  });

  describe("getCutoffDate", () => {
    // Pin the clock through a FakeTimer so the function and its expectation read
    // the SAME instant — the real-clock version flakes when the two Date() reads
    // straddle midnight. A fixed mid-day UTC anchor keeps the day arithmetic
    // unambiguous regardless of the host timezone.
    const anchorMs = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z

    const cases: Array<[string, number, string]> = [
      ["zero days is the anchor day", 0, "2026-06-15"],
      ["one day back", 1, "2026-06-14"],
      ["seven days back", 7, "2026-06-08"],
      ["thirty days back crosses the month boundary", 30, "2026-05-16"],
      ["a full year back crosses the year boundary", 365, "2025-06-15"],
    ];

    it.each(cases)("%s", (_name, daysOld, expectedDate) => {
      const timer = new FakeTimer();
      timer.setCurrentTime(anchorMs);
      const cutoff = getCutoffDate(daysOld, timer.now());
      expect(cutoff.slice(0, 10)).toBe(expectedDate);
    });

    it("returns a full ISO-8601 timestamp preserving the injected time of day", () => {
      const timer = new FakeTimer();
      timer.setCurrentTime(anchorMs);
      const cutoff = getCutoffDate(1, timer.now());
      expect(cutoff).toBe("2026-06-14T12:00:00.000Z");
    });

    it("defaults to the real clock when no time is injected", () => {
      const cutoff = getCutoffDate(1);
      expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  // (Deleted the "constants" block: WEIGHT_BOUNDS / DEFAULT_TTL / DEFAULT_EMA_ALPHA
  // were lockstep restatements of the source values. Each constant's *effect* is
  // covered behaviorally instead: WEIGHT_BOUNDS by adjustWeight, DEFAULT_TTL by
  // cleanupStaleBaselines' default, and DEFAULT_EMA_ALPHA by the default-alpha
  // updateBaseline test in MemoryBaselineManager.test.ts.)
});
