import { describe, expect, test } from "bun:test";
import { optionalBoolean, optionalEnum, optionalInteger, optionalString, queryParamsToRecord } from "../../src/server/queryParamValidation";

describe("queryParamValidation", () => {
  test("normalizes optional scalar parameters", () => {
    expect(optionalString("  value  ")).toBe("value");
    expect(optionalString("   ")).toBeUndefined();
    expect(optionalInteger(" 2 ", "limit", { min: 1, max: 2 })).toBe(2);
    expect(optionalBoolean("TRUE", "isCi")).toBe(true);
    expect(optionalEnum("asc", "order", ["asc", "desc"] as const)).toBe("asc");
  });

  test("rejects invalid values instead of silently dropping filters", () => {
    expect(() => optionalInteger("1.5", "limit")).toThrow("Invalid limit");
    expect(() => optionalBoolean("sometimes", "latestOnly")).toThrow("Invalid latestOnly");
    expect(() => optionalEnum("sideways", "order", ["asc", "desc"] as const)).toThrow("Invalid order");
  });

  test("rejects duplicate query keys", () => {
    expect(() => queryParamsToRecord("limit=1&limit=2")).toThrow("Duplicate query parameter: limit");
    expect(queryParamsToRecord("limit=1&testClass=A")).toEqual({ limit: "1", testClass: "A" });
  });

  // Issue #4187: the duplicate guard used `key in entries` against a `{}` map, so any
  // key that names an `Object.prototype` member was rejected as a duplicate on its
  // first (and only) occurrence.
  describe("prototype-named query parameters", () => {
    const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

    test.each([
      ...PROTOTYPE_KEYS.map(key => [key, `${key}=x`, { [key]: "x" }] as const),
      // Control row: a normal key must still round-trip.
      ["normal control key", "limit=1", { limit: "1" }] as const,
    ])("accepts a single %s parameter", (_label, query, expected) => {
      const record = queryParamsToRecord(query);
      expect({ ...record }).toEqual(expected as Record<string, string>);
    });

    test.each([
      ...PROTOTYPE_KEYS.map(key => [key, `${key}=x&${key}=y`] as const),
      // Control row: the duplicate check itself must not have been disabled.
      ["limit", "limit=1&limit=2"] as const,
    ])("still rejects a genuine duplicate %s", (key, query) => {
      expect(() => queryParamsToRecord(query)).toThrow(`Duplicate query parameter: ${key}`);
    });

    test("returned record does not inherit from Object.prototype", () => {
      expect(Object.getPrototypeOf(queryParamsToRecord("limit=1"))).toBeNull();
    });
  });
});
