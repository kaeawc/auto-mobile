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

  test("maps the deprecated positional form unchanged", () => {
    const perf = new NoOpPerformanceTracker();
    const signal = new AbortController().signal;
    expect(resolveViewHierarchyReadArgs(perf, true, 5, signal, 100)).toEqual({
      perf,
      skipWaitForFresh: true,
      minTimestamp: 5,
      signal,
      readOptions: 100,
    });
  });

  test("an options object without a read policy resolves no read options", () => {
    expect(resolveViewHierarchyReadArgs({ minTimestamp: 1 }).readOptions).toBeUndefined();
  });
});

describe("resolveAccessibilityHierarchyArgs", () => {
  test("distinguishes a performance tracker from the options form", () => {
    const perf = new NoOpPerformanceTracker();
    expect(resolveAccessibilityHierarchyArgs(perf, false, 0, true).perf).toBe(perf);
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
