import { ActionableError } from "../../models/ActionableError";
import type { Element } from "../../models/Element";
import { boundsNearlyEqual } from "../../utils/bounds";
import type { ViewHierarchyResult } from "../../models";
import { StaleDisplayError } from "../../models/StaleDisplayError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";

/** Bare native IDs resolve globally; only a complete tree can prove uniqueness. */
export async function resourceIdActionError(
  resourceId: string,
  readHierarchy: () => Promise<ViewHierarchyResult | null>,
  selectedElement?: Element,
): Promise<string | undefined> {
  let hierarchy: ViewHierarchyResult | null;
  try {
    hierarchy = await readHierarchy();
  } catch (error) {
    if (error instanceof StaleDisplayError) {
      throw error;
    }
    logger.warn(`[TalkBack] Cannot verify resource-id uniqueness: ${errorMessage(error)}`, error);
    return `Unable to verify uniqueness of resource-id "${resourceId}"; using coordinate fallback.`;
  }
  if (
    !hierarchy ||
    hierarchy.hierarchy.error ||
    hierarchy.ctrlProxyIncomplete ||
    hierarchy.truncationReasons?.length ||
    hierarchy.windows?.some((window) => window.truncationReasons?.length)
  ) {
    return `Unable to verify uniqueness of resource-id "${resourceId}" in an incomplete hierarchy; using coordinate fallback.`;
  }
  // Match SetAccessibilityFocus and CtrlProxy's full-ID / short-ID normalization.
  const candidates = new SearchableHierarchy()
    .project(hierarchy)
    .filter((node) => node.nativeId === resourceId || node.nativeId?.endsWith(`:id/${resourceId}`));
  // The full tree may be newer than selector resolution. Duplicate-ID fallback
  // is safe only while the selected row still exists at the selected bounds.
  assertSelectedElementPresent(candidates, selectedElement);
  const sharing = new Set(candidates.map((node) => node.source)).size;
  if (sharing !== 1) {
    return sharing > 1
      ? `Selected resource-id "${resourceId}" is shared by ${sharing} elements; using coordinate fallback.`
      : `Resource-id "${resourceId}" is absent from the current hierarchy; using coordinate fallback.`;
  }
  return undefined;
}

// FocusElementMatcher permits nearest-bounds matching for navigation; this
// dispatch guard must instead require the selected row's exact captured edges.
function assertSelectedElementPresent(candidates: SearchableEntry[], selected?: Element): void {
  if (!selected) {
    return;
  }
  const present = candidates.some((node) => {
    const identityMatches = (["text", "content-desc"] as const).every(
      (field) => !selected[field] || node.properties[field] === selected[field],
    );
    return (
      identityMatches &&
      (!selected.bounds ||
        (node.bounds !== undefined && boundsNearlyEqual(node.bounds, selected.bounds, 0)))
    );
  });
  if (!present) {
    throw new ActionableError(
      "Element not found in the current hierarchy at the selected bounds. Observe again before tapping.",
    );
  }
}
