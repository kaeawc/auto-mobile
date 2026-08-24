import { describe, expect, test } from "bun:test";
import {
  summarizeObserveResultForFailure,
  trimObservationForStepCapture,
} from "../../../src/utils/plan/summarizeFailureObservation";

describe("summarizeObserveResultForFailure", () => {
  test("collects visible texts and resource ids from elements buckets", () => {
    const tree = { type: "root", children: [{ type: "node" }] };
    const raw = {
      activeWindow: { appId: "com.example.app" },
      awaitTimeout: true,
      viewHierarchy: tree,
      rawViewHierarchy: { xml: "<hierarchy />" },
      elements: {
        clickable: [
          { text: "  Sign in  ", resourceId: "com.example.app:id/go" },
          { text: "Cancel", resourceId: undefined },
        ],
        text: [{ text: "Welcome", resourceId: "" }],
        scrollable: [],
      },
    };

    const s = summarizeObserveResultForFailure(raw as Record<string, unknown>);
    expect(s.activeWindow).toEqual({ appId: "com.example.app" });
    expect(s.awaitTimeout).toBe(true);
    expect(s.viewHierarchy).toEqual(tree);
    expect(s.rawViewHierarchy).toEqual({ xml: "<hierarchy />" });
    expect(s.visibleTextsSample).toContain("Sign in");
    expect(s.visibleTextsSample).toContain("Cancel");
    expect(s.visibleTextsSample).toContain("Welcome");
    expect(s.resourceIdsSample).toContain("com.example.app:id/go");
  });

  test("handles missing elements", () => {
    const s = summarizeObserveResultForFailure({ activeWindow: null } as Record<string, unknown>);
    expect(s.visibleTextsSample).toEqual([]);
    expect(s.resourceIdsSample).toEqual([]);
  });
});

describe("trimObservationForStepCapture", () => {
  test("summary strips hierarchy fields", () => {
    const s = summarizeObserveResultForFailure({
      viewHierarchy: { a: 1 },
      rawViewHierarchy: { b: 2 },
      elements: { clickable: [], scrollable: [], text: [{ text: "x", resourceId: "id" }] },
    } as Record<string, unknown>);
    const t = trimObservationForStepCapture(s, "summary");
    expect(t.viewHierarchy).toBeUndefined();
    expect(t.rawViewHierarchy).toBeUndefined();
    expect(t.visibleTextsSample).toContain("x");
  });

  test("full preserves hierarchy fields", () => {
    const s = summarizeObserveResultForFailure({
      viewHierarchy: { a: 1 },
    } as Record<string, unknown>);
    const t = trimObservationForStepCapture(s, "full");
    expect(t.viewHierarchy).toEqual({ a: 1 });
  });
});
