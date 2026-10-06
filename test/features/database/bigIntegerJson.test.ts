import { describe, expect, test } from "bun:test";
import { parseJsonKeepingBigIntegers } from "../../../src/features/database/bigIntegerJson";

describe("parseJsonKeepingBigIntegers", () => {
  test("matches JSON.parse when no integer is outside the safe range", () => {
    const json = `{"columns":["a"],"rows":[[1,-2,3.5,1e20,"9007199254740993",null,true]],"total":1}`;

    expect(parseJsonKeepingBigIntegers(json)).toEqual(JSON.parse(json));
  });

  test("does not stringify a float or exponent literal that exceeds the safe range", () => {
    const parsed = parseJsonKeepingBigIntegers<{ rows: number[][] }>(
      `{"rows":[[12345678901234567890.0,1.0E20]]}`,
    );

    expect(parsed.rows).toEqual([[12345678901234567000, 1e20]]);
  });

  test("returns unsafe integers as exact digits and keeps neighbours numeric", () => {
    const parsed = parseJsonKeepingBigIntegers<{ rows: unknown[][]; bigIntegerColumns: number[] }>(
      `{"rows":[[9007199254740993,-9223372036854775808,42]]}`,
    );

    expect(parsed.rows).toEqual([["9007199254740993", "-9223372036854775808", 42]]);
    expect(parsed.bigIntegerColumns).toEqual([0, 1]);
  });

  test("reports each affected column once, in ascending order", () => {
    const parsed = parseJsonKeepingBigIntegers<{ bigIntegerColumns: number[] }>(
      `{"rows":[[1,9007199254740993],[9007199254740995,2],[3,9007199254740997]]}`,
    );

    expect(parsed.bigIntegerColumns).toEqual([0, 1]);
  });

  test("leaves an unsafe integer outside rows as the number JSON.parse produced", () => {
    const parsed = parseJsonKeepingBigIntegers<{ total: number; bigIntegerColumns?: number[] }>(
      `{"total":9007199254740993,"rows":[[1]]}`,
    );

    expect(parsed.total).toBe(9007199254740992);
    expect(parsed.bigIntegerColumns).toBeUndefined();
  });
});
