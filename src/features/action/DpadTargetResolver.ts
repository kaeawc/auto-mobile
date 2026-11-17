import type { FocusNavigateOptions, FocusNavigateTarget, FocusScreen } from "./FocusNavigate";
import type { ElementBounds } from "../../models/ElementBounds";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { Element } from "../../models/Element";
import { boundsArea } from "../../utils/bounds";
import { isTruthyFlag } from "../utility/elementProperties";
import { type SearchableEntry, SearchableHierarchy } from "../utility/SearchableNode";
import { compareSelectionRank, type SelectionRank } from "../utility/selectionRank";
import { elementMatchesTarget } from "./FocusNavigateMatching";

/**
 * Picks a focus target for this screen read: its bounds, null when nothing matches, or undefined
 * when this read cannot be resolved (no hierarchy), which leaves matching to the focus loop.
 */
export interface DpadTargetResolver {
  resolve(screen: FocusScreen, target: FocusNavigateTarget): ElementBounds | null | undefined;
}

/**
 * Resolve with tapOn's own selector and the options its touch path uses for a plain text or
 * elementId tap, so hint-text fallback, ranking, actionable-ancestor promotion and synthetic ids
 * agree between touch and D-pad. A non-focusable label yields to a matching focusable control
 * unless that would trade an exact label for a contains match; see {@link focusableLabelFallback}.
 */
export class SelectorDpadTargetResolver implements DpadTargetResolver {
  constructor(
    private readonly selector: Pick<ElementSelector, "select">,
    private readonly searchable: Pick<SearchableHierarchy, "project"> = new SearchableHierarchy(),
  ) {}

  resolve(screen: FocusScreen, target: FocusNavigateTarget): ElementBounds | null | undefined {
    if (!screen.hierarchy) {
      return undefined;
    }
    if (target.label) {
      const selection = this.selector.select(
        screen.hierarchy,
        { text: target.label },
        {
          partialMatch: true,
          caseSensitive: false,
          strategy: "first",
          intentAction: "inspect",
          allowHintFallback: true,
          selectionIntent: "tap",
        },
      );
      if (!isTruthyFlag(selection.element?.focusable)) {
        const fallback = focusableLabelFallback(this.searchable.project(screen.hierarchy), target.label);
        if (fallback) {
          return fallback;
        }
      }
      return selection.element?.bounds ?? null;
    }
    if (target.elementId) {
      const selection = this.selector.select(
        screen.hierarchy,
        { elementId: target.elementId },
        { partialMatch: false, strategy: "first", intentAction: "inspect" },
      );
      return selection.element?.bounds ?? null;
    }
    return undefined;
  }
}

interface LabelCandidate extends SelectionRank {
  entry: SearchableEntry;
  element: Element;
  exact: boolean;
}

/** Topmost window first, then exact before contains, then tapOn's smallest-area, hierarchy order. */
function compareLabelCandidates(a: LabelCandidate, b: LabelCandidate): number {
  return (
    a.windowRank - b.windowRank ||
    Number(b.exact) - Number(a.exact) ||
    compareSelectionRank(a, b)
  );
}

function labelCandidates(entries: readonly SearchableEntry[], label: string): LabelCandidate[] {
  return entries
    .flatMap((entry) => {
      const element = entry.element;
      if (!element || !elementMatchesTarget(element, { label })) {
        return [];
      }
      const exact = elementMatchesTarget(element, { label, labelExact: true });
      return [
        {
          entry,
          element,
          exact,
          windowRank: entry.windowRank,
          area: boundsArea(element.bounds),
          order: entry.index,
          interactive: false,
        },
      ];
    })
    .sort(compareLabelCandidates);
}

/** The nearest focusable, non-scrolling ancestor that owns focus for a non-focusable label. */
function focusableAncestor(
  entries: readonly SearchableEntry[],
  entry: SearchableEntry,
): Element | undefined {
  for (let index = entry.parentIndex; index !== undefined; index = entries[index]?.parentIndex) {
    const element = entries[index]?.element;
    if (element && isTruthyFlag(element.scrollable)) {
      return undefined;
    }
    if (element && isTruthyFlag(element.focusable)) {
      return element;
    }
  }
  return undefined;
}

/**
 * Bounds to pin when tapOn's label target cannot take focus: the best focusable label match, unless
 * a non-focusable exact match ranks at least as high (same or higher window) and the focusable one
 * only contains the label; then the exact match's focusable ancestor, or undefined to keep tapOn's.
 */
export function focusableLabelFallback(
  entries: readonly SearchableEntry[],
  label: string,
): Element["bounds"] | undefined {
  const candidates = labelCandidates(entries, label);
  const focusable = candidates.find((candidate) => isTruthyFlag(candidate.element.focusable));
  if (!focusable) {
    return undefined;
  }
  const exact = candidates.find((candidate) => candidate.exact);
  if (!focusable.exact && exact && exact.windowRank <= focusable.windowRank) {
    return focusableAncestor(entries, exact.entry)?.bounds;
  }
  return focusable.element.bounds;
}

/** Whether `until` is only a `label` or only an `elementId`, the targets tapOn's resolver reads. */
export function isPinnableFocusTarget(until: FocusNavigateTarget): boolean {
  const fields = Object.entries(until).filter(([, value]) => value !== undefined);
  return fields.length === 1 && (fields[0][0] === "label" || fields[0][0] === "elementId");
}

/**
 * Focus walk options that pin a target named the way tapOn names one (only a `label` or only an
 * `elementId`) on each read, preferring a focusable label match when the tap target cannot focus.
 * A focused parent row never stands in for an independently actionable child. The resolver reads
 * that one field, so a target combining it with other fields keeps focusNavigate's own matching,
 * which checks every field.
 */
export function pinnedFocusOptions(
  until: FocusNavigateTarget,
  resolver: DpadTargetResolver,
): Pick<FocusNavigateOptions, "firstMatch" | "pinTarget"> {
  if (!isPinnableFocusTarget(until)) {
    return {};
  }
  return { firstMatch: true, pinTarget: (screen) => resolver.resolve(screen, until) };
}
