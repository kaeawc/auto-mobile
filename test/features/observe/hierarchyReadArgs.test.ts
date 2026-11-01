import { describe, expect, test } from "bun:test";
import {
  resolveAccessibilityHierarchyArgs,
  resolveViewHierarchyReadArgs,
} from "../../../src/features/observe/hierarchyReadArgs";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";

describe("resolveViewHierarchyReadArgs", () => {
  test("maps the options form, flattening the read policy", () => {
    const signal = new AbortController().signal;
    expect(
      resolveViewHierarchyReadArgs({
        skipWaitForFresh: true,
        minTimestamp: 5,
        signal,
        timeoutMs: 100,
        requireFreshExtraction: true,
      }),
    ).toEqual({
      skipWaitForFresh: true,
      minTimestamp: 5,
      signal,
      readOptions: { timeoutMs: 100, requireFreshExtraction: true },
    });
  });

  test("an options object without a read policy resolves no read options", () => {
    expect(resolveViewHierarchyReadArgs({ minTimestamp: 1 }).readOptions).toBeUndefined();
  });
});

describe("resolveAccessibilityHierarchyArgs", () => {
  test("resolves the request into read values and read options", () => {
    const perf = new NoOpPerformanceTracker();
    expect(resolveAccessibilityHierarchyArgs({ perf }).perf).toBe(perf);
    expect(resolveAccessibilityHierarchyArgs().readOptions).toBeUndefined();
    expect(resolveAccessibilityHierarchyArgs({ disableAllFiltering: true, timeoutMs: 7 })).toEqual({
      perf: undefined,
      skipWaitForFresh: undefined,
      minTimestamp: undefined,
      disableAllFiltering: true,
      signal: undefined,
      readOptions: { timeoutMs: 7, requireFreshExtraction: undefined },
    });
  });
});
