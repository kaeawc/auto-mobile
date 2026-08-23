import { describe, expect, test } from "bun:test";
import {
  SQLITE_MAX_BOUND_PARAMETERS,
  appendToBucket,
  chunkBySqliteParameterLimit,
} from "../../src/db/sqliteBatch";

/**
 * Direct coverage for the SQLite parameter-limit chunker shared by 9 analytics
 * queries (sqliteBatch.ts). A chunking off-by-one silently drops rows from an
 * `IN (...)` batch; the `chunkSize < 1` throw is otherwise unreachable from any
 * caller. The table rows below are the specification, boundaries included.
 */
describe("chunkBySqliteParameterLimit", () => {
  test.each([
    // [label, valuesLength, fixedParams, maxBound, expectedChunkSizes]
    ["empty input yields no chunks", 0, 0, 10, []],
    ["fewer values than the chunk size fit in one chunk", 3, 0, 10, [3]],
    ["exactly the chunk size fits in one chunk", 10, 0, 10, [10]],
    ["one over the chunk size splits into two chunks", 11, 0, 10, [10, 1]],
    ["an exact multiple splits into equal full chunks", 20, 0, 10, [10, 10]],
    ["fixed parameters shrink the usable chunk size", 12, 4, 10, [6, 6]],
    ["a single value is its own chunk", 1, 0, 10, [1]],
  ])("%s", (_label, valuesLength, fixedParams, maxBound, expectedSizes) => {
    const values = Array.from({ length: valuesLength as number }, (_v, i) => i);

    const chunks = chunkBySqliteParameterLimit(values, fixedParams as number, maxBound as number);

    expect(chunks.map((c) => c.length)).toEqual(expectedSizes as number[]);
    // No value is dropped and order is preserved across the chunk boundary.
    expect(chunks.flat()).toEqual(values);
  });

  test("defaults to the SQLite 999-parameter ceiling", () => {
    const values = Array.from({ length: 1000 }, (_v, i) => i);

    const chunks = chunkBySqliteParameterLimit(values);

    expect(SQLITE_MAX_BOUND_PARAMETERS).toBe(999);
    expect(chunks.map((c) => c.length)).toEqual([999, 1]);
    expect(chunks.flat()).toEqual(values);
  });

  test("throws when the fixed parameters leave no room for a single value", () => {
    expect(() => chunkBySqliteParameterLimit([1, 2, 3], 10, 10)).toThrow(
      "SQLite batch query has 10 fixed parameters, exceeding 10 available bound parameters",
    );
  });

  test("throws when the fixed parameters exceed the bound-parameter ceiling", () => {
    expect(() => chunkBySqliteParameterLimit([1], 12, 10)).toThrow(
      /12 fixed parameters, exceeding 10 available/,
    );
  });
});

describe("appendToBucket", () => {
  test("creates a new bucket for a first-seen key", () => {
    const buckets = new Map<string, number[]>();

    appendToBucket(buckets, "a", 1);

    expect(buckets.get("a")).toEqual([1]);
  });

  test("appends to an existing bucket in insertion order", () => {
    const buckets = new Map<string, number[]>();

    appendToBucket(buckets, "a", 1);
    appendToBucket(buckets, "a", 2);
    appendToBucket(buckets, "b", 3);

    expect(buckets.get("a")).toEqual([1, 2]);
    expect(buckets.get("b")).toEqual([3]);
  });
});
