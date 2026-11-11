import type { ElementBounds } from "../../models/ElementBounds";
import type { SearchableEntry } from "./SearchableNode";

type CountedEntry = Pick<SearchableEntry, "affordances" | "bounds" | "label">;

interface TappableTarget {
  bounds: ElementBounds;
  label: string;
}

const TAPPABLE_AFFORDANCES = new Set<SearchableEntry["affordances"][number]>([
  "tap",
  "toggle",
  "long-press",
]);

function contains(outer: ElementBounds, inner: ElementBounds): boolean {
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom
  );
}

function tappableTarget(candidate: CountedEntry): TappableTarget | null {
  if (
    !candidate.bounds ||
    !candidate.affordances.some((affordance) => TAPPABLE_AFFORDANCES.has(affordance))
  ) {
    return null;
  }
  return { bounds: candidate.bounds, label: candidate.label?.trim().toLowerCase() ?? "" };
}

/** Whether `inner` is the same control as `outer`: same label, inside its bounds. */
function collapsesInto(inner: TappableTarget, outer: TappableTarget): boolean {
  return (
    inner.label.length > 0 && inner.label === outer.label && contains(outer.bounds, inner.bounds)
  );
}

/**
 * How many distinct tappable targets a tap selector's candidates name (#17939). A candidate
 * with no tap/toggle/long-press affordance (an iOS `context` label) is not counted, and a
 * tappable candidate whose bounds lie inside another tappable candidate with the same label
 * (an iOS settings row and its switch) counts once with its container.
 */
export function countTappableMatches(candidates: readonly CountedEntry[]): number {
  const tappable = candidates
    .map(tappableTarget)
    .filter((target): target is TappableTarget => target !== null);
  // A target with identical bounds to an earlier one collapses into it, so the pair counts once.
  return tappable.filter(
    (target, index) =>
      !tappable.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          collapsesInto(target, other) &&
          (!contains(target.bounds, other.bounds) || otherIndex < index),
      ),
  ).length;
}
