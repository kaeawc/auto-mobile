import { describe, expect, test } from "bun:test";
import { hasMaterialLayoutWarningChange } from "../../../../src/features/observe/output/ObserveResultOutput";
import type { LayoutWarning } from "../../../../src/models/ObservationInsets";

const row: LayoutWarning = {
  type: "interaction-in-system-gesture-region",
  severity: "info",
  element: {
    viewId: "s2-0123456789abcdef",
    resourceId: "android:id/checkbox",
    bounds: { left: 0, top: 100, right: 98, bottom: 200 },
  },
  categories: ["interaction"],
  insetTypes: ["systemGestures"],
  sides: ["left"],
  overflowPx: { left: 20 },
  insetPx: { left: 78 },
  overlapPercent: 20,
  confidence: "medium",
};

const envelope = (...warnings: LayoutWarning[]) => ({ scope: "full", warnings });

describe("hasMaterialLayoutWarningChange (#17515)", () => {
  test("an added warning is material", () => {
    const key = { ...row, element: { ...row.element, resourceId: undefined, contentDesc: "q" } };
    expect(hasMaterialLayoutWarningChange(envelope(row), envelope(row, key))).toBe(true);
  });

  test("a changed side on the same warning is material", () => {
    expect(
      hasMaterialLayoutWarningChange(envelope(row), envelope({ ...row, sides: ["right"] })),
    ).toBe(true);
  });

  test("a changed scope or total is material", () => {
    expect(
      hasMaterialLayoutWarningChange(envelope(row), { ...envelope(row), scope: "capped" }),
    ).toBe(true);
    expect(hasMaterialLayoutWarningChange(envelope(row), { ...envelope(row), total: 7 })).toBe(
      true,
    );
  });

  test("confidence and s2- view id churn are not material", () => {
    const churned = {
      ...row,
      confidence: "high" as const,
      element: { ...row.element, viewId: "s2-fedcba9876543210" },
    };
    expect(hasMaterialLayoutWarningChange(envelope(row), envelope(churned))).toBe(false);
  });

  test("compacted bounds equal to object bounds are not material", () => {
    // The observe compact mode serializes bounds as `[l, t, r, b]`.
    const compacted: LayoutWarning = JSON.parse(
      JSON.stringify({ ...row, element: { ...row.element, bounds: [0, 100, 98, 200] } }),
    );
    expect(hasMaterialLayoutWarningChange(envelope(row), envelope(compacted))).toBe(false);
  });

  test("a SystemUI status-bar warning is not material", () => {
    const icon: LayoutWarning = {
      ...row,
      type: "important-content-under-inset",
      element: { resourceId: "com.android.systemui:id/icon", bounds: row.element.bounds },
    };
    expect(hasMaterialLayoutWarningChange(envelope(row), envelope(row, icon))).toBe(false);
  });

  test("two absent envelopes are not material", () => {
    expect(hasMaterialLayoutWarningChange(undefined, undefined)).toBe(false);
  });
});
