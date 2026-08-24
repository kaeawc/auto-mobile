import type { ViewHierarchyResult } from "../models/ViewHierarchyResult";
import type { ElementParser } from "./interfaces/ElementParser";

const RESOURCE_ID_LOADING_HINT =
  /progress_bar|loading_indicator|progress_indicator|shimmer|content_loading/i;

const CLASS_LOADING_HINT =
  /ProgressBar$|ProgressIndicator|ShimmerFrameLayout|ContentLoadingProgressBar/i;

/**
 * Heuristic: true when the accessibility tree likely shows a blocking loading overlay
 * (spinner, progress bar, shimmer) that can temporarily remove list rows before tap.
 */
export function androidViewHierarchyIndicatesLikelyBlockingLoading(
  viewHierarchy: ViewHierarchyResult,
  elementParser: ElementParser,
): boolean {
  const roots = [
    ...elementParser.extractRootNodes(viewHierarchy),
    ...elementParser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
  ];

  let found = false;
  for (const root of roots) {
    elementParser.traverseNode(root, (node: unknown) => {
      if (found) {
        return;
      }
      const props = elementParser.extractNodeProperties(node as object);
      const rid = String(props["resource-id"] ?? props.resourceId ?? "");
      const className = String(props.class ?? props.className ?? "");
      if (rid.length > 0 && RESOURCE_ID_LOADING_HINT.test(rid)) {
        found = true;
        return;
      }
      if (className.length > 0 && CLASS_LOADING_HINT.test(className)) {
        found = true;
      }
    });
    if (found) {
      break;
    }
  }

  return found;
}
