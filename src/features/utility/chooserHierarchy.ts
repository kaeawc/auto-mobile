import type { ElementBounds, ExecResult, ViewHierarchyResult } from "../../models";
import { type ViewHierarchyNode } from "../../models/ViewHierarchyResult";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
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

export const CHOOSER_SCAN_PAGES = 4;

interface ChooserSwipe {
  direction?: "up" | "down";
  capturedAt?: number;
  signal?: AbortSignal;
  swipe(args: string[], signal?: AbortSignal): Promise<Pick<ExecResult, "stderr" | "error">>;
  read(minTimestamp: number, signal?: AbortSignal): Promise<ViewHierarchyResult>;
  validate(hierarchy: ViewHierarchyResult, minTimestamp: number): void;
}

/** Moves a chooser viewport and returns a refreshed tree when the swipe changed it. */
export async function swipeChooserList(
  current: ViewHierarchyResult,
  bounds: ElementBounds | undefined,
  { direction = "up", ...gesture }: ChooserSwipe,
): Promise<ViewHierarchyResult | null> {
  if (!bounds || bounds.bottom - bounds.top < 40) {
    return null;
  }
  const centerX = Math.round((bounds.left + bounds.right) / 2);
  const height = bounds.bottom - bounds.top;
  const lowerY = Math.round(bounds.bottom - height / 4);
  const upperY = Math.round(bounds.top + height / 4);
  const [fromY, toY] = direction === "up" ? [lowerY, upperY] : [upperY, lowerY];
  return swipeAndRead(current, { x: centerX, fromY, toY }, gesture);
}

/**
 * Drags a collapsed chooser sheet up by its handle and returns the refreshed tree when the
 * sheet moved. A swipe inside a collapsed sheet's short list strip travels too little for the
 * drawer to settle open, so it snaps back and the rows below stay hidden (#14246).
 */
export async function expandChooserSheet(
  current: ViewHierarchyResult,
  handle: ElementBounds,
  gesture: Omit<ChooserSwipe, "direction">,
): Promise<ViewHierarchyResult | null> {
  const x = Math.round((handle.left + handle.right) / 2);
  const fromY = Math.round((handle.top + handle.bottom) / 2);
  // Ending a quarter of the way down from the top drags well past the drawer's halfway point.
  return swipeAndRead(current, { x, fromY, toY: Math.round(fromY / 4) }, gesture);
}

async function swipeAndRead(
  current: ViewHierarchyResult,
  { x, fromY, toY }: { x: number; fromY: number; toY: number },
  { capturedAt, signal, swipe, read, validate }: Omit<ChooserSwipe, "direction">,
): Promise<ViewHierarchyResult | null> {
  throwIfAborted(signal);
  const result = await awaitWhileRequestIsLive(
    swipe(["swipe", String(x), String(fromY), String(x), String(toY), "350"], signal),
    signal,
  );
  const failure = result.error || result.stderr?.trim();
  if (failure) {
    throw new Error(`Could not scroll chooser app list: ${failure}`);
  }
  const minTimestamp = Math.max(current.updatedAt ?? 0, capturedAt ?? 0) + 1;
  throwIfAborted(signal);
  const fresh = await awaitWhileRequestIsLive(read(minTimestamp, signal), signal);
  validate(fresh, minTimestamp);
  return JSON.stringify(fresh.hierarchy) === JSON.stringify(current.hierarchy) ? null : fresh;
}
