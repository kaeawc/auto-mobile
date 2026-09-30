import type { ViewHierarchyResult } from "../../src/models";

export const outerBounds = { left: 0, top: 0, right: 320, bottom: 120 };
export const innerBounds = { left: 20, top: 10, right: 220, bottom: 80 };
export const labelBounds = { left: 40, top: 25, right: 120, bottom: 55 };

export const nestedClickableHierarchy: ViewHierarchyResult = {
  hierarchy: {
    node: {
      "resource-id": "app:id/outer",
      clickable: true,
      bounds: outerBounds,
      node: {
        "resource-id": "app:id/inner",
        clickable: true,
        bounds: innerBounds,
        node: { text: "Wi-Fi", bounds: labelBounds },
      },
    },
  },
};
