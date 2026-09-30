import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";

/** iOS Forms row: the labelled switch row encloses the smaller actionable control. */
export function iosFormsSwitch(checked: "true" | "false"): ViewHierarchyResult {
  return {
    screenWidth: 402,
    screenHeight: 874,
    hierarchy: {
      node: {
        $: { class: "XCUIElementTypeApplication" },
        node: [
          {
            $: {
              class: "UISwitch",
              text: "Enable Notifications",
              clickable: "true",
              checkable: "true",
              bounds: { left: 20, top: 284, right: 382, bottom: 336 },
            },
            node: [
              {
                $: {
                  class: "UISwitch",
                  clickable: "true",
                  checkable: "true",
                  checked,
                  "sdk.accessibilityTraits": "button,toggleButton",
                  bounds: { left: 301, top: 296, right: 364, bottom: 324 },
                },
              },
            ],
          },
        ],
      },
    },
  };
}
