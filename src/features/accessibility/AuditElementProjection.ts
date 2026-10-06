import type { Element } from "../../models/Element";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import { resolveViewHierarchyForSearch } from "../../utils/viewHierarchySearch";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";

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

/** Image-like classes: an icon next to a number makes the number a badge, not the control's name. */
const ICON_CLASS = /Image|Icon/i;

/**
 * A merged descendant label only names the container when it says something. A
 * lone decorative glyph ("•") is announced by TalkBack but does not describe the
 * control, so it must not hide a missing content description. Any letter (any
 * script) is enough.
 *
 * A purely numeric label is a name only for a single-text control, where the digit
 * IS the control (a dial-pad or PIN-pad key "1"). A number beside other content (an
 * icon, or other text) is a count badge and still does not name the control.
 */
function isMeaningfulLabel(
  label: string | undefined,
  entries: readonly SearchableEntry[],
  container: SearchableEntry,
): boolean {
  if (/\p{L}/u.test(label ?? "")) {
    return true;
  }
  return /\p{N}/u.test(label ?? "") && isSingleTextControl(entries, container);
}

/** Exactly one text-bearing descendant and no icon: the text is the whole control. */
function isSingleTextControl(entries: readonly SearchableEntry[], container: SearchableEntry) {
  let textual = 0;
  for (let i = container.index + 1; i < entries.length; i++) {
    const descendant = entries[i];
    if (descendant.rootGroup !== container.rootGroup || descendant.depth <= container.depth) {
      break;
    }
    if (ICON_CLASS.test(descendant.className ?? "")) {
      return false;
    }
    if (
      (descendant.element?.text ?? "").trim() ||
      (descendant.element?.["content-desc"] ?? "").trim()
    ) {
      textual += 1;
    }
  }
  return textual === 1;
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
      isMeaningfulLabel(entry.displayedLabel, entries, entry)
    ) {
      descendantLabelled.add(entry.element);
    }
  }
  return { elements, descendantLabelled };
}
