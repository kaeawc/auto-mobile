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
});
