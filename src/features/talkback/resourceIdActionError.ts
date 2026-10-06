import { ActionableError } from "../../models/ActionableError";
import type { Element } from "../../models/Element";
import { boundsNearlyEqual } from "../../utils/bounds";
import type { ViewHierarchyResult } from "../../models";
import { StaleDisplayError } from "../../models/StaleDisplayError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";

/**
 * CtrlProxy replies `Element not found with <target>` when its node lookup misses. The selector was
 * resolved from a hierarchy the device itself produced, so this says the lookup missed (for
 * example the element sits in a window the lookup did not search), not that the press is
 * impossible; semantic actions treat it like any other lookup failure and use coordinates.
 */
export function isNodeNotFoundReply(error: string | undefined): boolean {
  return error?.startsWith("Element not found with ") === true;
}

/** An advertised semantic action the device rejected, as opposed to one whose lookup missed. */
export function isRejectedSemanticAction(advertised: boolean, error: string | undefined): boolean {
  return advertised && !isNodeNotFoundReply(error);
}

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
  if (!isCompleteHierarchy(hierarchy)) {
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
      "Selected element moved or is gone from the current hierarchy. Observe again before tapping.",
    );
  }
}

/** Internal selector-resolution context; a supplied capture was read in this tap call. */
export interface TalkBackTargetContext {
  hierarchy?: ViewHierarchyResult;
  reResolve?: (hierarchy: ViewHierarchyResult) => Element | null;
  onResolvedElement?: (element: Element) => void;
}

/**
 * A newer tree is authoritative. Reuse the caller's original selector/index once,
 * never a nearest-bounds matcher. "Different" means a changed captured identity
 * (text, description, native/test/unique ID or collection position), or an empty
 * resolution. Identical labelled duplicates require the caller's same index;
 * without an original resolver we cannot prove a moved row safe.
 */
export async function resolveTalkBackActionTarget(
  selected: Element,
  readHierarchy: () => Promise<ViewHierarchyResult | null>,
  context: TalkBackTargetContext = {},
): Promise<{ element: Element; hierarchy: ViewHierarchyResult | null }> {
  // Standalone strategy callers retain their existing stable-selector support
  // policy. Tool calls supply the hierarchy they actually resolved in this call.
  if (usesStandaloneNodeSelector(selected, context)) {
    return { element: selected, hierarchy: null };
  }
  const hierarchy = context.hierarchy ?? (await readTalkBackTargetHierarchy(readHierarchy));
  if (!isCompleteHierarchy(hierarchy) && !hasResolutionContext(context)) {
    return { element: selected, hierarchy };
  }
  if (!hierarchy || hierarchy.hierarchy.error) {
    throw new ActionableError(
      "Cannot confirm the selected element because the accessibility hierarchy is unavailable. Observe again and check that the accessibility service is running.",
    );
  }
  return confirmSelectedTarget(selected, hierarchy, context);
}

function confirmSelectedTarget(
  selected: Element,
  hierarchy: ViewHierarchyResult,
  context: TalkBackTargetContext,
): { element: Element; hierarchy: ViewHierarchyResult } {
  const present = selectedTargetPresent(selected, hierarchy);
  // A supplied tree already resolved this selector in this call. A device read
  // is newer and must also check index ordering, even if the old row still exists.
  if ((!context.hierarchy || !present) && context.reResolve) {
    const current = reResolveSelectedTarget(context.reResolve, hierarchy);
    if (!current) {
      throw new ActionableError(
        "Selected element moved or is gone; the original selector no longer resolves. Observe again before tapping.",
      );
    }
    if (!sameCapturedIdentity(selected, current)) {
      throw new ActionableError(
        "Selected element moved; the original selector now resolves to a different element. Observe again before tapping.",
      );
    }
    if (!current.bounds) {
      throw new ActionableError(
        "Selected element moved and has no current bounds. Observe again before tapping.",
      );
    }
    context.onResolvedElement?.(current);
    return { element: current, hierarchy };
  }
  if (!present) {
    throw new ActionableError(
      "Selected element moved or is gone from the current hierarchy. Observe again before tapping.",
    );
  }
  return { element: selected, hierarchy };
}

function sameCapturedIdentity(selected: Element, current: Element): boolean {
  return (
    [
      "text",
      "content-desc",
      "resource-id",
      "test-tag",
      "unique-id",
      "collection-row-index",
      "collection-column-index",
    ] as const
  ).every((field) => selected[field] === undefined || selected[field] === current[field]);
}

export function isCompleteHierarchy(
  hierarchy: ViewHierarchyResult | null,
): hierarchy is ViewHierarchyResult {
  return (
    !!hierarchy &&
    !hierarchy.hierarchy.error &&
    !hierarchy.ctrlProxyIncomplete &&
    !hierarchy.truncationReasons?.length &&
    !hierarchy.windows?.some((window) => window.truncationReasons?.length)
  );
}

async function readTalkBackTargetHierarchy(
  readHierarchy: () => Promise<ViewHierarchyResult | null>,
): Promise<ViewHierarchyResult | null> {
  try {
    return await readHierarchy();
  } catch (error) {
    if (error instanceof StaleDisplayError) {
      throw error;
    }
    logger.warn(`[TalkBack] Cannot confirm selected target: ${errorMessage(error)}`, error);
    return null;
  }
}

function selectedTargetPresent(selected: Element, hierarchy: ViewHierarchyResult): boolean {
  return new SearchableHierarchy()
    .project(hierarchy)
    .some(
      (node) =>
        sameCapturedIdentity(selected, node.properties) &&
        (!selected.bounds || (!!node.bounds && boundsNearlyEqual(node.bounds, selected.bounds, 0))),
    );
}

function hasResolutionContext(context: TalkBackTargetContext): boolean {
  return !!(context.hierarchy || context.reResolve);
}

function usesStandaloneNodeSelector(selected: Element, context: TalkBackTargetContext): boolean {
  return (
    !hasResolutionContext(context) &&
    (!selected["resource-id"] || !!selected["test-tag"] || !!selected["unique-id"])
  );
}

function reResolveSelectedTarget(
  resolve: NonNullable<TalkBackTargetContext["reResolve"]>,
  hierarchy: ViewHierarchyResult,
): Element | null {
  try {
    return resolve(hierarchy);
  } catch (error) {
    if (error instanceof StaleDisplayError) {
      throw error;
    }
    throw new ActionableError(
      "Selected element moved or is gone; the original selector cannot resolve unambiguously in the newer hierarchy. Observe again before tapping.",
      { cause: error },
    );
  }
}
