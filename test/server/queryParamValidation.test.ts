import { describe, expect, test } from "bun:test";
import {
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  queryParamsToRecord,
} from "../../src/server/queryParamValidation";

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
    expect(() => optionalEnum("sideways", "order", ["asc", "desc"] as const)).toThrow(
      "Invalid order",
    );
  });

  test("rejects duplicate query keys", () => {
    expect(() => queryParamsToRecord("limit=1&limit=2")).toThrow(
      "Duplicate query parameter: limit",
    );
    expect(queryParamsToRecord("limit=1&testClass=A")).toEqual({ limit: "1", testClass: "A" });
  });

  // Issue #4187: the duplicate guard used `key in entries` against a `{}` map, so any
  // key that names an `Object.prototype` member was rejected as a duplicate on its
  // first (and only) occurrence.
  describe("prototype-named query parameters", () => {
    const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

    test.each([
      ...PROTOTYPE_KEYS.map((key) => [key, `${key}=x`, { [key]: "x" }] as const),
      // Control row: a normal key must still round-trip.
      ["normal control key", "limit=1", { limit: "1" }] as const,
    ])("accepts a single %s parameter", (_label, query, expected) => {
      const record = queryParamsToRecord(query);
      expect({ ...record }).toEqual(expected as Record<string, string>);
    });

    test.each([
      ...PROTOTYPE_KEYS.map((key) => [key, `${key}=x&${key}=y`] as const),
      // Control row: the duplicate check itself must not have been disabled.
      ["limit", "limit=1&limit=2"] as const,
    ])("still rejects a genuine duplicate %s", (key, query) => {
      expect(() => queryParamsToRecord(query)).toThrow(`Duplicate query parameter: ${key}`);
    });

    test("returned record does not inherit from Object.prototype", () => {
      expect(Object.getPrototypeOf(queryParamsToRecord("limit=1"))).toBeNull();
    });
  });

  // Issue #4181, rank 8: optionalInteger delegates to bare Number(), which
  // accepts hex/exponent/whitespace forms that a query-string integer should
  // arguably reject, and applies an implicit min:0 floor. These rows PIN the
  // real behavior — including the surprising ones — so a change is visible.
  describe("optionalInteger boundary table", () => {
    test.each([
      // [label, input, options, expected]
      ["undefined passes through", undefined, {}, undefined],
      ["blank string is undefined", "   ", {}, undefined],
      ["plain integer", "42", {}, 42],
      ["zero accepted by default (implicit min:0)", "0", {}, 0],
      ["surrounding whitespace trimmed", "  7  ", {}, 7],
      ["hex literal silently accepted as decimal", "0x10", {}, 16],
      ["exponent literal silently accepted", "1e3", {}, 1000],
      ["explicit min honored", "5", { min: 5 }, 5],
      ["negative allowed when min is negative", "-3", { min: -5 }, -3],
    ] as const)("returns %s", (_label, input, options, expected) => {
      expect(optionalInteger(input, "limit", options)).toBe(expected);
    });

    test.each([
      ["negative rejected by implicit min:0 floor", "-1", {}],
      ["fractional rejected", "1.5", {}],
      ["non-numeric rejected", "abc", {}],
      ["empty-after-parse NaN rejected", "NaN", {}],
      ["infinity rejected", "Infinity", {}],
      ["above MAX_SAFE_INTEGER rejected", "9007199254740993", {}],
      ["above explicit max rejected", "11", { max: 10 }],
      ["below explicit min rejected", "2", { min: 5 }],
    ] as const)("throws for %s", (_label, input, options) => {
      expect(() => optionalInteger(input, "limit", options)).toThrow("Invalid limit");
    });
  });

  describe("optionalBoolean boundary table", () => {
    test.each([
      ["undefined passes through", undefined, undefined],
      ["blank string is undefined", "  ", undefined],
      ["true literal", "true", true],
      ["TRUE case-insensitive", "TRUE", true],
      ["1 is true", "1", true],
      ["false literal", "false", false],
      ["FALSE case-insensitive", "FALSE", false],
      ["0 is false", "0", false],
    ] as const)("returns %s", (_label, input, expected) => {
      expect(optionalBoolean(input, "flag")).toBe(expected);
    });

    test.each([
      ["yes", "yes"],
      ["2", "2"],
      ["empty-after-trim is undefined not error", "sometimes"],
    ] as const)("throws for unrecognized %s", (_label, input) => {
      expect(() => optionalBoolean(input, "flag")).toThrow("Invalid flag");
    });
  });
});
