import { describe, expect, test } from "bun:test";
import type { SkeletonElement } from "../../src/models/ObserveResult";
import { freshTapTarget } from "../integration/foldableTapTarget";

// Skeleton entries copied from an `observe` of a Pixel 10 Pro Fold AVD (API 36) with a framework
// ANR dialog up; the dialog's buttons are the whole tappable skeleton, so the old first-labeled
// pick tapped "Close app".
const anrDialogSkeleton: SkeletonElement[] = [
  {
    bounds: [246, 1051, 1829, 1168],
    affordances: ["tap"],
    elementId: "android:id/aerr_close",
    label: "Close app",
  },
  {
    bounds: [246, 1168, 1829, 1285],
    affordances: ["tap"],
    elementId: "android:id/aerr_wait",
    label: "Wait",
  },
];

const settingsSkeleton: SkeletonElement[] = [
  {
    bounds: [0, 371, 2076, 2074],
    affordances: ["scroll"],
    elementId: "com.android.settings:id/recycler_view",
  },
  {
    bounds: [39, 156, 2037, 332],
    affordances: ["tap"],
    elementId: "com.android.settings:id/search_action_bar",
    label: "Search Settings",
  },
];

describe("foldable fresh tap target", () => {
  test("refuses to tap a system error dialog and names its buttons", () => {
    expect(() => freshTapTarget(anrDialogSkeleton)).toThrow(
      "A system error dialog covers the active panel (Close app, Wait)",
    );
  });

  test("refuses even when app elements sit under the dialog", () => {
    expect(() => freshTapTarget([...settingsSkeleton, ...anrDialogSkeleton])).toThrow(
      "refusing to tap it",
    );
  });

  test("taps the center of the first labeled tappable element", () => {
    const fresh = freshTapTarget(settingsSkeleton);

    expect(fresh).toEqual({ x: 1038, y: 244, target: settingsSkeleton[1] });
  });

  test("rejects a panel without a labeled tappable element", () => {
    expect(() => freshTapTarget([settingsSkeleton[0]])).toThrow(
      "No labeled tappable element on the active panel",
    );
    expect(() => freshTapTarget(undefined)).toThrow("No labeled tappable element");
  });
});
