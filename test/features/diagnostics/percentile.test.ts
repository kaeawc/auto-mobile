import { describe, expect, test } from "bun:test";
import { percentile, summarizeLatencies } from "../../../src/features/diagnostics/percentile";


describe("percentile", function() {

  test("empty input returns 0", function() {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 99)).toBe(0);
  });


  test("single-element returns that element for any percentile", function() {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });


  test("p50 of even-length sample interpolates the middle", function() {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
  });


  test("p100 returns max, p0 returns min", function() {
    const sorted = [1, 5, 10, 100];
    expect(percentile(sorted, 0)).toBe(1);
    expect(percentile(sorted, 100)).toBe(100);
  });
});


describe("summarizeLatencies", function() {

  test("empty samples produces an all-zero record with count=0", function() {
    const result = summarizeLatencies([]);
    expect(result).toEqual({
      count: 0,
      minMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    });
  });


  test("sorts input internally — callers don't need to pre-sort", function() {
    const result = summarizeLatencies([100, 1, 50, 10, 5]);
    expect(result.minMs).toBe(1);
    expect(result.maxMs).toBe(100);
    expect(result.count).toBe(5);
  });


  test("rounds percentiles to whole milliseconds", function() {
    const result = summarizeLatencies([10, 20]);
    expect(Number.isInteger(result.p50Ms)).toBe(true);
    expect(Number.isInteger(result.p90Ms)).toBe(true);
    expect(Number.isInteger(result.p99Ms)).toBe(true);
  });
});
