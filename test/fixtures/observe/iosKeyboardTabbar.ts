import capture from "./ios-keyboard-tabbar/observe-keyboard-up.json";
import type {
  ElementBounds,
  SkeletonElement,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";

function requiredRow(
  rows: typeof capture.skeleton | typeof capture.context,
  match: (row: (typeof rows)[number]) => boolean,
): SkeletonElement {
  const row = rows.find(match);
  if (!row || row.bounds.length !== 4) {
    throw new Error("Missing captured iOS keyboard row");
  }
  return { ...row, bounds: row.bounds as SkeletonElement["bounds"], affordances: [] };
}

export const iosKeyboardCapture = {
  screenSize: capture.screenSize,
  ime: requiredRow(capture.skeleton, (row) => row.elementId === "<ime>"),
  demos: requiredRow(capture.skeleton, (row) => row.label === "Demos"),
  emoji: requiredRow(capture.skeleton, (row) => row.label === "Emoji"),
  dictate: requiredRow(capture.skeleton, (row) => row.label === "Dictate"),
  predictions: requiredRow(capture.context, (row) => row.label === "Typing Predictions"),
  displayName: requiredRow(
    capture.skeleton,
    (row) => row.label === "MTB4" && "sublabel" in row && row.sublabel === "Display Name",
  ),
};

export function capturedBounds(row: SkeletonElement): ElementBounds {
  const [left, top, right, bottom] = row.bounds;
  return { left, top, right, bottom };
}

/** Synthetic scaffolding from observe OUTPUT bounds, not a captured raw hierarchy. */
export function iosKeyboardTabbarHierarchy(container = false): ViewHierarchyResult {
  const button = (
    row: SkeletonElement,
    className = "XCUIElementTypeButton",
  ): ViewHierarchyNode => ({
    $: {
      text: row.label,
      "resource-id": row.elementId,
      class: className,
      clickable: true,
      bounds: capturedBounds(row),
    },
  });
  const key = button(
    { ...iosKeyboardCapture.ime, elementId: "key-q", label: "Q" },
    "UIKeyboardKey",
  );
  const keyboard = container
    ? {
        $: { class: "UIKeyboard" },
        node: [key, button(iosKeyboardCapture.emoji), button(iosKeyboardCapture.dictate)],
      }
    : key;
  return {
    screenWidth: iosKeyboardCapture.screenSize.width,
    screenHeight: iosKeyboardCapture.screenSize.height,
    hierarchy: {
      node: {
        $: {},
        node: [
          button(iosKeyboardCapture.demos),
          button(iosKeyboardCapture.displayName, "UITextField"),
          button(iosKeyboardCapture.predictions, "XCUIElementTypeStaticText"),
          ...(!container
            ? [button(iosKeyboardCapture.emoji), button(iosKeyboardCapture.dictate)]
            : []),
          keyboard,
        ],
      },
    },
  };
}
