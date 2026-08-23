import { describe, expect, test } from "bun:test";
import { DefaultElementParser } from "../../src/features/utility/ElementParser";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import { androidViewHierarchyIndicatesLikelyBlockingLoading } from "../../src/utils/androidTransientLoading";

const parser = new DefaultElementParser();

function hierarchyWithNode(node: Record<string, unknown>): ViewHierarchyResult {
  return {
    hierarchy: { node },
  } as unknown as ViewHierarchyResult;
}

describe("androidViewHierarchyIndicatesLikelyBlockingLoading", () => {
  test("true when resource-id contains progress_bar", () => {
    const h = hierarchyWithNode({
      "resource-id": "com.app:id/progress_bar_loading",
      class: "android.view.View",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    expect(androidViewHierarchyIndicatesLikelyBlockingLoading(h, parser)).toBe(true);
  });

  test("true for ProgressBar class", () => {
    const h = hierarchyWithNode({
      class: "android.widget.ProgressBar",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    expect(androidViewHierarchyIndicatesLikelyBlockingLoading(h, parser)).toBe(true);
  });

  test("false for unrelated views", () => {
    const h = hierarchyWithNode({
      "resource-id": "com.app:id/title",
      class: "android.widget.TextView",
      text: "Hello",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    expect(androidViewHierarchyIndicatesLikelyBlockingLoading(h, parser)).toBe(false);
  });

  // Enumerate every resource-id hint the detector matches
  // (RESOURCE_ID_LOADING_HINT), so the surface can't silently narrow.
  const RESOURCE_ID_HINTS = [
    "progress_bar",
    "loading_indicator",
    "progress_indicator",
    "shimmer",
    "content_loading",
  ];
  test.each(RESOURCE_ID_HINTS)("true when resource-id contains %s", (hint) => {
    const h = hierarchyWithNode({
      "resource-id": `com.app:id/${hint}`,
      class: "android.view.View",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    expect(androidViewHierarchyIndicatesLikelyBlockingLoading(h, parser)).toBe(true);
  });

  // Enumerate every class hint (CLASS_LOADING_HINT).
  const CLASS_HINTS = [
    "android.widget.ProgressBar",
    "com.google.android.material.progressindicator.CircularProgressIndicator",
    "com.facebook.shimmer.ShimmerFrameLayout",
    "androidx.core.widget.ContentLoadingProgressBar",
  ];
  test.each(CLASS_HINTS)("true for loading class %s", (className) => {
    const h = hierarchyWithNode({
      class: className,
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    expect(androidViewHierarchyIndicatesLikelyBlockingLoading(h, parser)).toBe(true);
  });

  test("hints are case-insensitive", () => {
    const h = hierarchyWithNode({
      "resource-id": "com.app:id/LOADING_INDICATOR",
      class: "android.view.View",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    expect(androidViewHierarchyIndicatesLikelyBlockingLoading(h, parser)).toBe(true);
  });

  test("ProgressBar class hint is anchored - a mid-string match does not trip it", () => {
    // CLASS_LOADING_HINT uses `ProgressBar$`, so a class that merely contains
    // "ProgressBar" but does not end with it (and matches no other hint) is false.
    const h = hierarchyWithNode({
      class: "com.app.ProgressBarWidget",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    expect(androidViewHierarchyIndicatesLikelyBlockingLoading(h, parser)).toBe(false);
  });
});
