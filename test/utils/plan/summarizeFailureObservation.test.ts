import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
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

  // Captured observe payloads (default skeleton projection, no `elements`); see each
  // fixture directory's README for how it was captured (#17308).
  test("collects samples from skeleton and context rows of a captured Android observe", () => {
    const capture = readFixture("intent-chooser/observe-skeleton.json") as {
      result: { structuredContent: Record<string, unknown> };
    };
    const raw = capture.result.structuredContent;
    expect(raw.elements).toBeUndefined();

    const s = summarizeObserveResultForFailure(raw);
    // skeleton labels and sublabels
    expect(s.visibleTextsSample).toContain("Chrome");
    expect(s.visibleTextsSample).toContain("Just once");
    expect(s.visibleTextsSample).toContain("Chat");
    // context (non-actionable) labels
    expect(s.visibleTextsSample).toContain("Share");
    expect(s.resourceIdsSample).toContain("android:id/button_once");
    expect(s.resourceIdsSample).toContain("android:id/title");
  });

  test("collects samples from skeleton and context rows of a captured iOS observe", () => {
    const raw = readFixture("ios-lock-state/observe-unlocked.json") as Record<string, unknown>;
    expect(raw.elements).toBeUndefined();

    const s = summarizeObserveResultForFailure(raw);
    expect(s.visibleTextsSample).toContain("Settings");
    expect(s.visibleTextsSample).toContain("Dock");
    expect(s.resourceIdsSample).toContain("spotlight-pill");
  });

  test("keeps legacy elements samples and adds skeleton rows without duplicates", () => {
    const s = summarizeObserveResultForFailure({
      elements: { clickable: [{ text: "Sign in", resourceId: "com.example.app:id/go" }] },
      skeleton: [
        {
          bounds: [0, 0, 1, 1],
          affordances: ["tap"],
          elementId: "com.example.app:id/go",
          label: "Sign in",
        },
      ],
      context: [{ bounds: [0, 0, 1, 1], affordances: [], label: "Welcome" }],
    } as Record<string, unknown>);
    expect(s.visibleTextsSample).toEqual(["Sign in", "Welcome"]);
    expect(s.resourceIdsSample).toEqual(["com.example.app:id/go"]);
  });

  test("handles missing elements", () => {
    const s = summarizeObserveResultForFailure({ activeWindow: null } as Record<string, unknown>);
    expect(s.visibleTextsSample).toEqual([]);
    expect(s.resourceIdsSample).toEqual([]);
  });
});

function readFixture(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(path.join(import.meta.dir, "../../fixtures", relativePath), "utf8"),
  );
}

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
