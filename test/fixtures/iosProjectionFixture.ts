import type { ViewHierarchyResult } from "../../src/models";

/** A collapsible wrapper, a visible peer, and a fully offscreen peer. */
export function iosProjectionFixture(): ViewHierarchyResult {
  return {
    packageName: "com.test.app",
    updatedAt: 1,
    screenWidth: 100,
    screenHeight: 100,
    hierarchy: {
      bounds: [0, 0, 100, 100],
      node: [
        {
          class: "WKWebView",
          bounds: [10, 10, 30, 30],
          node: {
            class: "XCUIElementTypeButton",
            "resource-id": "source-id",
            text: "Source",
            clickable: true,
            bounds: [10, 10, 30, 30],
          },
        },
        { "resource-id": "target-id", text: "Target", bounds: [60, 60, 80, 80] },
        { "resource-id": "hidden-id", text: "Hidden", bounds: [10, 500, 30, 520] },
      ],
    },
  };
}
