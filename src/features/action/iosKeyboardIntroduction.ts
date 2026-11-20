import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { nodeAttributes, nodeBounds } from "../../models/ViewHierarchyResult";
import { parseBounds } from "../../utils/bounds";
import { DefaultElementParser } from "../utility/ElementParser";

/**
 * UIKit's one-time "slide to type" introduction. On a fresh simulator it replaces the
 * software keyboard the first time a field becomes first responder, so the focus read sees
 * neither a focused field nor a keyboard (#18910). The resource id is the UIKit class name,
 * so it does not depend on the device language.
 */
export const IOS_CONTINUOUS_PATH_INTRODUCTION_ID = "UIContinuousPathIntroductionView";

/** The introduction's dismiss button, as a screen point to tap. */
export interface IosKeyboardIntroduction {
  x: number;
  y: number;
}

/**
 * Finds the keyboard introduction and the centre of its single dismiss button. Returns
 * undefined when there is no introduction, or when it has no unambiguous button with bounds.
 */
export function findIosKeyboardIntroduction(
  hierarchy: ViewHierarchyResult,
): IosKeyboardIntroduction | undefined {
  const parser = new DefaultElementParser();
  const introductions: ViewHierarchyNode[] = [];
  const roots = [
    ...parser.extractRootNodes(hierarchy),
    ...parser.extractWindowRootNodes(hierarchy),
  ];
  for (const root of roots) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      if (nodeAttributes(node)["resource-id"] === IOS_CONTINUOUS_PATH_INTRODUCTION_ID) {
        introductions.push(node);
      }
    });
  }
  const introduction = introductions[0];
  if (!introduction) {
    return undefined;
  }
  const buttons: ViewHierarchyNode[] = [];
  parser.traverseNode(introduction, (node: ViewHierarchyNode) => {
    const { clickable } = nodeAttributes(node);
    if (node !== introduction && (clickable === true || clickable === "true")) {
      buttons.push(node);
    }
  });
  const bounds = buttons.length === 1 ? parseBounds(nodeBounds(buttons[0]!)) : null;
  if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    return undefined;
  }
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2),
  };
}
