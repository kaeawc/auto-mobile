import type { Element } from "../../models/Element";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import { resolveViewHierarchyForSearch } from "../../utils/viewHierarchySearch";
import { SearchableHierarchy } from "../utility/SearchableNode";

/** Elements the WCAG audit inspects, plus which of them are labelled by merged descendants. */
export interface AuditElementProjection {
  /** Main-hierarchy elements in traversal order (what `flattenViewHierarchy` returned). */
  elements: Element[];
  /**
   * Clickable containers with no text/content-desc of their own whose accessible
   * label comes from descendant text or content descriptions, using the same
   * fold the observe skeleton applies to `label`/`sublabel` (`SearchableHierarchy`).
   * An accessibility service announces that merged text, so these are labelled.
   */
  descendantLabelled: ReadonlySet<Element>;
}

/**
 * A merged descendant label only names the container when it says something. A
 * purely numeric badge ("3") or a lone decorative glyph ("•") is announced by
 * TalkBack but does not describe the control, so it must not hide a missing
 * content description. Any letter (any script) is enough.
 */
function isMeaningfulLabel(label: string | undefined): boolean {
  return /\p{L}/u.test(label ?? "");
}

/**
 * Project a capture once for the audit. The label merge is the shared
 * `SearchableHierarchy` projection (real tree ancestry, smallest clickable
 * ancestor wins, nested clickables never swallow each other), not a second
 * implementation. Pass a fresh `SearchableHierarchy` per audit: the audit's
 * elements are the projection's own objects, which must not alias another
 * consumer's cached entries.
 */
export function projectAuditElements(
  capture: ViewHierarchyResult,
  searchable: SearchableHierarchy = new SearchableHierarchy(),
): AuditElementProjection {
  const entries = searchable.project(resolveViewHierarchyForSearch(capture) ?? capture);
  const elements: Element[] = [];
  const descendantLabelled = new Set<Element>();
  for (const entry of entries) {
    // Group 0 is the main hierarchy; window roots are separate groups the audit never read.
    if (entry.rootGroup !== 0 || !entry.element) {
      continue;
    }
    elements.push(entry.element);
    const hasOwnLabel = Boolean(entry.element.text || entry.element["content-desc"]);
    if (
      !hasOwnLabel &&
      entry.affordances.includes("tap") &&
      isMeaningfulLabel(entry.displayedLabel)
    ) {
      descendantLabelled.add(entry.element);
    }
  }
  return { elements, descendantLabelled };
}
