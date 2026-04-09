import { describe, expect, test } from "bun:test";
import { summarizeObserveResultForFailure } from "../../../src/utils/plan/summarizeFailureObservation";

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
          { text: "Cancel", resourceId: undefined }
        ],
        text: [{ text: "Welcome", resourceId: "" }],
        scrollable: []
      }
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
