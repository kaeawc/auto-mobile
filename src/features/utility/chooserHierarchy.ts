import { ViewHierarchyResult } from "../../models";
import { type ViewHierarchyNode } from "../../models/ViewHierarchyResult";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { logger } from "../../utils/logger";
import { textOrDescription, toSearchable } from "./SearchableNode";

/**
 * Detect system intent chooser dialog in view hierarchy
 * @param viewHierarchy - Current view hierarchy result
 * @returns True if intent chooser is detected
 */
export function detectIntentChooser(
  viewHierarchy: ViewHierarchyResult,
  parser: ElementParser,
): boolean {
  try {
    // If the hierarchy is empty, return false
    if (!viewHierarchy || !viewHierarchy.hierarchy || !viewHierarchy.hierarchy.node) {
      return false;
    }

    // Look for common intent chooser indicators
    const textIndicators = [
      "Choose an app",
      "Open with",
      "Complete action using",
      "Always",
      "Just once",
    ];

    const classIndicators = [
      "com.android.internal.app.ChooserActivity",
      "com.android.internal.app.ResolverActivity",
    ];

    const resourceIdIndicators = [
      "android:id/button_always",
      "android:id/button_once",
      "resolver_list",
      "chooser_list",
    ];

    // Get root nodes from the view hierarchy
    const rootNodes = parser.extractRootNodes(viewHierarchy);

    // Check all nodes in the hierarchy
    for (const rootNode of rootNodes) {
      let foundIndicator = false;

      parser.traverseNode(rootNode, (node: ViewHierarchyNode) => {
        if (foundIndicator) {
          return;
        }

        const nodeProperties = parser.extractNodeProperties(node);
        const nodeClass = nodeProperties.class || "";
        const searchable = toSearchable(nodeProperties);
        const nodeText = textOrDescription(searchable);
        const nodeResourceId = searchable.nativeId ?? "";

        // Check for class indicators
        for (const className of classIndicators) {
          if (nodeClass.includes(className)) {
            foundIndicator = true;
            return;
          }
        }

        // Check for text indicators (exact match)
        for (const text of textIndicators) {
          if (nodeText === text) {
            foundIndicator = true;
            return;
          }
        }

        // Check for resource ID indicators
        for (const resourceId of resourceIdIndicators) {
          if (nodeResourceId.includes(resourceId)) {
            foundIndicator = true;
            return;
          }
        }
      });

      if (foundIndicator) {
        return true;
      }
    }

    return false;
  } catch (error) {
    logger.warn(`[DeepLinkManager] Error detecting intent chooser: ${error}`);
    return false;
  }
}
