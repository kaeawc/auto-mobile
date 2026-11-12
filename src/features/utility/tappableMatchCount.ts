import type { ElementBounds } from "../../models/ElementBounds";
import type { SearchableEntry } from "./SearchableNode";
import type { BootedDevice } from "../../models/DeviceInfo";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { TapOnSelectedElement } from "../../models/TapOnElementResult";

type CountedEntry = Pick<SearchableEntry, "affordances" | "bounds" | "label" | "sublabel">;

interface TappableTarget {
  bounds: ElementBounds;
  label: string;
  sublabel: string;
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
  return {
    bounds: candidate.bounds,
    label: candidate.label?.trim().toLowerCase() ?? "",
    sublabel: candidate.sublabel?.toLowerCase() ?? "",
  };
}

/** Same-label controls fold into their container; announcing containers fold into their child. */
function collapsesInto(target: TappableTarget, other: TappableTarget): boolean {
  if (target.label === other.label) {
    return target.label.length > 0 && contains(other.bounds, target.bounds);
  }
  return (
    other.label.length > 0 &&
    target.sublabel.includes(other.label) &&
    contains(target.bounds, other.bounds)
  );
}

/**
 * How many distinct tappable targets a tap selector's candidates name (#17939). A candidate
 * with no tap/toggle/long-press affordance (an iOS `context` label) is not counted, and a
 * tappable candidate whose bounds lie inside another tappable candidate with the same label
 * (an iOS settings row and its switch) counts once with its container. A differently labelled
 * container announcing a contained target in its sublabel counts once with that target.
 */
export function countTappableMatches(candidates: readonly CountedEntry[]): number {
  const tappable = candidates
    .map(tappableTarget)
    .filter((target): target is TappableTarget => target !== null);
  // If both targets fold into each other, keep the earlier one so the pair still counts once.
  return tappable.filter(
    (target, index) =>
      !tappable.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          collapsesInto(target, other) &&
          (!collapsesInto(other, target) || otherIndex < index),
      ),
  ).length;
}

/**
 * Carries the selection's tappable count onto iOS tap metadata. Android keeps its established
 * count; iOS captures repeat a label in non-tappable context nodes and in a row's own switch.
 */
export function withIosTappableMatches(
  platform: BootedDevice["platform"],
  selection: Pick<ElementSelectionResult, "tappableMatches">,
  metadata: TapOnSelectedElement | undefined,
): TapOnSelectedElement | undefined {
  return metadata && platform === "ios" && selection.tappableMatches !== undefined
    ? { ...metadata, tappableMatches: selection.tappableMatches }
    : metadata;
}
