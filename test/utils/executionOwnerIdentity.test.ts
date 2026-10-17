import { describe, expect, test } from "bun:test";
import { compareExecutionOwnerIdentity } from "../../src/utils/executionOwnerIdentity";

describe("compareExecutionOwnerIdentity", () => {
  test("returns undefined without a recorded identity", () => {
    expect(compareExecutionOwnerIdentity(1, undefined, () => "same")).toBeUndefined();
  });

  test("returns the comparator verdict", () => {
    expect(compareExecutionOwnerIdentity(1, "x", () => "different")).toBe("different");
  });

  test("returns unknown when the comparator throws", () => {
    const verdict = compareExecutionOwnerIdentity(1, "x", () => {
      throw new Error("boom");
    });
    expect(verdict).toBe("unknown");
  });
});
