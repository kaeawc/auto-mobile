import type { ViewHierarchyResult } from "../../src/models";

/** A collapsible wrapper, a visible peer, and a fully offscreen peer. */
export function iosProjectionFixture(): ViewHierarchyResult {
  return {
    packageName: "com.test.app",
    updatedAt: 1,
    screenWidth: 100,
    screenHeight: 100,
    hierarchy: {
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: {
        node: [
          {
            class: "WKWebView",
            bounds: { left: 10, top: 10, right: 30, bottom: 30 },
            node: [
              {
                class: "XCUIElementTypeButton",
                "resource-id": "source-id",
                text: "Source",
                clickable: true,
                bounds: { left: 10, top: 10, right: 30, bottom: 30 },
              },
            ],
          },
          {
            "resource-id": "target-id",
            text: "Target",
            bounds: { left: 60, top: 60, right: 80, bottom: 80 },
          },
          {
            "resource-id": "hidden-id",
            text: "Hidden",
            bounds: { left: 10, top: 500, right: 30, bottom: 520 },
          },
        ],
      },
    },
  };
}
