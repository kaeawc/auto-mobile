import type { ViewHierarchyResult } from "../../models";
import { StaleDisplayError } from "../../models/StaleDisplayError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { SearchableHierarchy } from "../utility/SearchableNode";

/** Bare native IDs resolve globally; only a complete tree can prove uniqueness. */
export async function resourceIdActionError(
  resourceId: string,
  readHierarchy: () => Promise<ViewHierarchyResult | null>,
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
  const sharing = new Set(
    new SearchableHierarchy()
      .project(hierarchy)
      .filter(
        (node) => node.nativeId === resourceId || node.nativeId?.endsWith(`:id/${resourceId}`),
      )
      .map((node) => node.source),
  ).size;
  if (sharing !== 1) {
    return sharing > 1
      ? `Selected resource-id "${resourceId}" is shared by ${sharing} elements; using coordinate fallback.`
      : `Resource-id "${resourceId}" is absent from the current hierarchy; using coordinate fallback.`;
  }
  return undefined;
}
