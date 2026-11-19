import type { FocusNavigateOptions, FocusNavigateTarget, FocusScreen } from "./FocusNavigate";
import type { ElementBounds } from "../../models/ElementBounds";
import type { Element } from "../../models/Element";
import { boundsArea } from "../../utils/bounds";
import { isTruthyFlag } from "../utility/elementProperties";
import type { SearchableEntry } from "../utility/SearchableNode";
import type { ElementResolution } from "../utility/ElementResolver";
import type { ResolverElementSelector } from "../utility/ResolverElementSelector";
import { compareSelectionRank } from "../utility/selectionRank";
import { elementMatchesTarget, focusLabelSibling } from "./FocusNavigateMatching";

/**
 * Picks a focus target for this screen read: its bounds, null when nothing matches, or undefined
 * when this read cannot be resolved (no hierarchy), which leaves matching to the focus loop.
 */
export interface DpadTargetResolver {
  resolve(screen: FocusScreen, target: FocusNavigateTarget): ElementBounds | null | undefined;
}

/** The selector surface the resolver reads: tapOn's selection and the resolution behind it. */
export type DpadSelector = Pick<ResolverElementSelector, "selectWithResolution">;

/**
 * Resolve with tapOn's own selector and the options its touch path uses for a plain text or
 * elementId tap, so hint-text fallback, ranking, visibility filtering, actionable-ancestor
 * promotion and synthetic ids agree between touch and D-pad. A label whose tap target cannot take
 * focus pins the control that owns focus for it; see {@link focusOwnerBounds}.
 */
export class SelectorDpadTargetResolver implements DpadTargetResolver {
  constructor(private readonly selector: DpadSelector) {}

  resolve(screen: FocusScreen, target: FocusNavigateTarget): ElementBounds | null | undefined {
    if (!screen.hierarchy) {
      return undefined;
    }
    if (target.label) {
      const { selection, resolution } = this.selector.selectWithResolution(
        screen.hierarchy,
        { text: target.label },
        {
          partialMatch: !target.labelExact,
          caseSensitive: false,
          strategy: "first",
          intentAction: "inspect",
          allowHintFallback: true,
          selectionIntent: "tap",
        },
      );
      if (!selection.element) {
        return null;
      }
      return (
        focusOwnerBounds(resolution, target.label, target.labelExact) ?? selection.element.bounds
      );
    }
    if (target.elementId) {
      const { selection } = this.selector.selectWithResolution(
        screen.hierarchy,
        { elementId: target.elementId },
        { partialMatch: false, strategy: "first", intentAction: "inspect" },
      );
      return selection.element?.bounds ?? null;
    }
    return undefined;
  }
}

function isFocusable(element: Element | undefined): element is Element {
  return element !== undefined && isTruthyFlag(element.focusable);
}

function isClickable(element: Element | undefined): boolean {
  return element !== undefined && isTruthyFlag(element.clickable);
}

/**
 * The nearest clickable or focusable ancestor of `entry`: the walk stops at the first one, and a
 * scrolling container ends it without promoting focus ownership.
 */
function nearestActionableAncestor(
  nodes: readonly SearchableEntry[],
  entry: SearchableEntry,
): Element | undefined {
  for (let index = entry.parentIndex; index !== undefined; index = nodes[index]?.parentIndex) {
    const element = nodes[index]?.element;
    if (element && isTruthyFlag(element.scrollable)) {
      return element;
    }
    if (isFocusable(element) || isClickable(element)) {
      return element;
    }
  }
  return undefined;
}

/**
 * Bounds of the control that takes focus for tapOn's chosen label target. A focusable choice is
 * its own owner. A clickable, non-focusable choice is an independent control: it keeps its own
 * bounds, so a focused row around it never stands in for it. A pure label (neither focusable nor
 * clickable) is promoted to its nearest focusable ancestor; when the nearest actionable ancestor
 * is only clickable the label keeps its own bounds. A scrolling ancestor suppresses duplicate-label fallback, but permits a matching or unlabelled sibling in
 * the same parent row. A label with no actionable ancestor falls back to the
 * best focusable candidate from the same resolution (so the same visibility filtering applies) in
 * the chosen element's window, exact before contains, then smallest area and hierarchy order.
 * Undefined keeps tapOn's own bounds.
 */
export function focusOwnerBounds(
  resolution: Pick<ElementResolution, "chosen" | "candidates" | "snapshotNodes">,
  label: string,
  labelExact = false,
): ElementBounds | undefined {
  const chosen = resolution.chosen;
  if (!chosen?.element) {
    return undefined;
  }
  if (isTruthyFlag(chosen.element.focusable) || isClickable(chosen.element)) {
    return chosen.element.bounds;
  }
  const nodes = resolution.snapshotNodes ?? [];
  const ancestor = nearestActionableAncestor(nodes, chosen);
  if (ancestor) {
    return ancestorFocusBounds(ancestor, chosen, { nodes, target: { label, labelExact } });
  }
  return (
    focusableLabelBounds(resolution.candidates, chosen, { label, labelExact }) ??
    focusLabelSibling(nodes, chosen)?.bounds
  );
}

function ancestorFocusBounds(
  ancestor: Element,
  chosen: SearchableEntry,
  { nodes, target }: { nodes: readonly SearchableEntry[]; target: FocusNavigateTarget },
): ElementBounds | undefined {
  if (isTruthyFlag(ancestor.scrollable)) {
    return focusLabelSibling(nodes, chosen, target)?.bounds ?? chosen.element?.bounds;
  }
  return isFocusable(ancestor) ? ancestor.bounds : chosen.element?.bounds;
}

function focusableLabelBounds(
  candidates: readonly SearchableEntry[],
  chosen: SearchableEntry,
  target: FocusNavigateTarget,
): ElementBounds | undefined {
  const [best] = candidates
    .flatMap((entry) =>
      entry.windowRank === chosen.windowRank &&
      isFocusable(entry.element) &&
      elementMatchesTarget(entry.element, target)
        ? [
            {
              element: entry.element,
              exact: elementMatchesTarget(entry.element, { ...target, labelExact: true }),
              windowRank: entry.windowRank,
              area: boundsArea(entry.element.bounds),
              order: entry.index,
              interactive: false,
            },
          ]
        : [],
    )
    .sort((a, b) => Number(b.exact) - Number(a.exact) || compareSelectionRank(a, b));
  return best?.element.bounds;
}

/** Whether `until` is only a `label` or only an `elementId`, the targets tapOn's resolver reads. */
export function isPinnableFocusTarget(until: FocusNavigateTarget): boolean {
  const fields = Object.entries(until).filter(([, value]) => value !== undefined);
  return fields.length === 1 && (fields[0][0] === "label" || fields[0][0] === "elementId");
}

/**
 * Focus walk options that pin a target named the way tapOn names one (only a `label` or only an
 * `elementId`) on each read, pinning the control that owns focus when the tap target cannot focus.
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
