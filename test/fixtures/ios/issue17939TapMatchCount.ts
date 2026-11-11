import type { ViewHierarchyResult } from "../../../src/models";
import { wireCapture } from "../../helpers/wireCapture";

/**
 * Issue #17939 (iOS 26.5, iPhone 17 simulator). `observe` showed one `Add` toolbar button in
 * `skeleton` and the same label again in `context` (`"Dogfood"`/`"Add"` entries with
 * `affordances: []`); the Settings `Dark mode` row (`[16, 97, 386, 149]`) contains its switch
 * (`[309, 109, 372, 137]`) with the same label. tapOn reported `2 matches (index 0)` for both.
 */
export function issue17939Hierarchy(): ViewHierarchyResult {
  return wireCapture({
    screenWidth: 402,
    screenHeight: 874,
    hierarchy: {
      bounds: [0, 0, 402, 874],
      className: "XCUIApplication",
      node: [
        {
          bounds: [0, 62, 402, 106],
          className: "UINavigationBar",
          node: [
            { bounds: [150, 70, 252, 98], className: "UILabel", text: "Dogfood" },
            { bounds: [338, 62, 386, 106], className: "UIButton", text: "Add", clickable: "true" },
          ],
        },
        // The `context` entry: the same label with no affordance.
        { bounds: [16, 180, 386, 210], className: "UILabel", text: "Add" },
        {
          bounds: [16, 97, 386, 149],
          className: "UICollectionViewListCell",
          text: "Dark mode",
          clickable: "true",
          node: [
            { bounds: [32, 113, 120, 133], className: "UILabel", text: "Dark mode" },
            {
              bounds: [309, 109, 372, 137],
              className: "UISwitch",
              text: "Dark mode",
              clickable: "true",
              checkable: "true",
              checked: "false",
            },
          ],
        },
      ],
    },
  });
}

/** The `tapOn {"selector":{"text":...}}` lookup options (`TapElementFinder.selectText`). */
export const issue17939TapLookup = {
  partialMatch: true,
  caseSensitive: false,
  intentAction: "inspect",
  allowHintFallback: true,
  selectionIntent: "tap",
} as const;
