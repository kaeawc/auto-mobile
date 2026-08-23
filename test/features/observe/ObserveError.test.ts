import { describe, expect, test } from "bun:test";
import { appendObserveError } from "../../../src/features/observe/ObserveError";
import type { ObserveResult } from "../../../src/models";

function makeResult(): ObserveResult {
  return {
    updatedAt: 0,
    screenSize: { width: 0, height: 0 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

describe("appendObserveError", () => {
  test("initializes errors array on first call", () => {
    const result = makeResult();
    expect(result.errors).toBeUndefined();
    appendObserveError(result, { phase: "screenSize", message: "boom" });
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors!.length).toBe(1);
    expect(result.errors![0]).toEqual({ phase: "screenSize", message: "boom" });
  });

  test("multiple calls accumulate into the errors array", () => {
    const result = makeResult();
    appendObserveError(result, { phase: "screenSize", message: "first" });
    appendObserveError(result, { phase: "rotation", message: "second" });
    appendObserveError(result, { phase: "viewHierarchy", message: "third", cause: "io" });
    expect(result.errors!.length).toBe(3);
    expect(result.errors!.map((e) => e.phase)).toEqual(["screenSize", "rotation", "viewHierarchy"]);
    expect(result.errors![2].cause).toBe("io");
  });

  test("derived error string is semicolon-joined messages", () => {
    const result = makeResult();
    appendObserveError(result, { phase: "screenSize", message: "first" });
    expect(result.error).toBe("first");
    appendObserveError(result, { phase: "rotation", message: "second" });
    expect(result.error).toBe("first; second");
    appendObserveError(result, { phase: "viewHierarchy", message: "third" });
    expect(result.error).toBe("first; second; third");
  });

  test("preserves a pre-existing error string by migrating it into errors[]", () => {
    // Back-compat with the legacy `appendError(result, msg)` helper, which
    // concatenated onto an existing `result.error` string. Code that sets
    // `result.error` directly (without going through structured errors) keeps
    // that value as the first entry.
    const result = makeResult();
    result.error = "legacy-preexisting";
    appendObserveError(result, { phase: "critical", message: "fresh" });
    expect(result.errors!.map((e) => e.message)).toEqual(["legacy-preexisting", "fresh"]);
    expect(result.error).toBe("legacy-preexisting; fresh");
    appendObserveError(result, { phase: "cache", message: "next" });
    expect(result.error).toBe("legacy-preexisting; fresh; next");
  });
});
