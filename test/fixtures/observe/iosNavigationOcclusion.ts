import type { ElementBounds, ViewHierarchyResult } from "../../../src/models";

export const navigationScreen = { width: 402, height: 874 };
export const navigationViewport = { left: 0, top: 0, right: 402, bottom: 874 };
export const coveredNavigationRow = { left: 16, top: 31, right: 386, bottom: 109 };
export const partialNavigationRow = { left: 16, top: 110, right: 386, bottom: 188 };
export const visibleNavigationRow = { left: 16, top: 120, right: 386, bottom: 198 };

// Synthetic issue #9096 geometry. No capture of the obscured Demos row exists in the repo.
export function syntheticNavigationHierarchy(
  row: ElementBounds = coveredNavigationRow,
  { navButton = false, bottomBar = false, keyboard = false } = {},
): ViewHierarchyResult {
  return {
    screenWidth: navigationScreen.width,
    screenHeight: navigationScreen.height,
    systemInsets: { top: 62, right: 0, bottom: 0, left: 0 },
    hierarchy: {
      node: {
        $: { class: "XCUIElementTypeWindow", bounds: navigationViewport },
        node: [
          {
            $: { class: "XCUIElementTypeScrollView", bounds: navigationViewport, scrollable: true },
            node: [
              {
                $: { class: "XCUIElementTypeCell", bounds: row, clickable: true },
                node: [{ $: { class: "UILabel", text: "Forms & Input", bounds: row } }],
              },
            ],
          },
          {
            $: { class: "UINavigationBar", bounds: { left: 0, top: 62, right: 402, bottom: 116 } },
            node: navButton
              ? [
                  {
                    $: {
                      class: "UIButton",
                      text: "Back",
                      clickable: true,
                      bounds: { left: 16, top: 70, right: 80, bottom: 108 },
                    },
                  },
                ]
              : [],
          },
          ...(bottomBar
            ? [
                {
                  $: { class: "UIToolbar", bounds: { left: 0, top: 790, right: 402, bottom: 874 } },
                },
              ]
            : []),
          ...(keyboard
            ? [
                {
                  $: {
                    class: "UIKeyboard",
                    bounds: { left: 0, top: 600, right: 402, bottom: 874 },
                  },
                  node: [
                    {
                      $: {
                        class: "UIKeyboardKey",
                        text: "Q",
                        clickable: true,
                        bounds: { left: 0, top: 600, right: 402, bottom: 850 },
                      },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
    },
  };
}
