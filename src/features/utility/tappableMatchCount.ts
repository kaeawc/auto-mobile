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
    namesLabel(target.sublabel, other.label) &&
    contains(target.bounds, other.bounds)
  );
}

/** Whether `sublabel` names `label` as a whole name, not inside a longer word (#18098). */
function namesLabel(sublabel: string, label: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${RegExp.escape(label)}(?![\\p{L}\\p{N}])`, "u").test(
    sublabel,
  );
}

/** Indices reachable from `start` along fold edges, including `start` itself. */
function reachableFrom(edges: readonly number[][], start: number): Set<number> {
  const reached = new Set<number>([start]);
  const pending = [start];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const target of edges[next]) {
      if (!reached.has(target)) {
        reached.add(target);
        pending.push(target);
      }
    }
  }
  return reached;
}

/**
 * How many distinct tappable targets a tap selector's candidates name (#17939). A candidate
 * with no tap/toggle/long-press affordance (an iOS `context` label) is not counted, and a
 * tappable candidate whose bounds lie inside another tappable candidate with the same label
 * (an iOS settings row and its switch) counts once with its container. A differently labelled
 * container naming a contained target's whole label in its sublabel counts once with that
 * target. Targets that fold into one another in a cycle count once together.
 */
export function countTappableMatches(candidates: readonly CountedEntry[]): number {
  const tappable = candidates
    .map(tappableTarget)
    .filter((target): target is TappableTarget => target !== null);
  const edges = tappable.map((target, index) =>
    tappable.flatMap((other, otherIndex) =>
      otherIndex !== index && collapsesInto(target, other) ? [otherIndex] : [],
    ),
  );
  const reach = tappable.map((_, index) => reachableFrom(edges, index));
  // Folds can form cycles (mutually announcing targets, #18098), so count the strongly connected
  // groups nothing folds out of: a target counts when everything it folds into folds back into
  // it, and only the earliest member of that group is counted.
  return reach.filter((reached, index) =>
    [...reached].every((other) => reach[other].has(index) && other >= index),
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
