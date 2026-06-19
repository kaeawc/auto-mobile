import { describe, expect, test } from "bun:test";
import { DefaultElementParser } from "../../src/features/utility/ElementParser";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import { androidViewHierarchyIndicatesLikelyBlockingLoading } from "../../src/utils/androidTransientLoading";

const parser = new DefaultElementParser();

function hierarchyWithNode(node: Record<string, unknown>): ViewHierarchyResult {
  return {
    hierarchy: { node }
  } as unknown as ViewHierarchyResult;
}

describe("androidViewHierarchyIndicatesLikelyBlockingLoading", () => {
  test("true when resource-id contains progress_bar", () => {
    const h = hierarchyWithNode({
      "resource-id": "com.app:id/progress_bar_loading",
      "class": "android.view.View",
      "bounds": { left: 0, top: 0, right: 10, bottom: 10 }
    });
    expect(androidViewHierarchyIndicatesLikelyBlockingLoading(h, parser)).toBe(true);
  });

  test("true for ProgressBar class", () => {
    const h = hierarchyWithNode({
      class: "android.widget.ProgressBar",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 }
    });
    expect(androidViewHierarchyIndicatesLikelyBlockingLoading(h, parser)).toBe(true);
  });

  test("false for unrelated views", () => {
    const h = hierarchyWithNode({
      "resource-id": "com.app:id/title",
      "class": "android.widget.TextView",
      "text": "Hello",
      "bounds": { left: 0, top: 0, right: 10, bottom: 10 }
    });
    expect(androidViewHierarchyIndicatesLikelyBlockingLoading(h, parser)).toBe(false);
  });
});
