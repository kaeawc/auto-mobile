import type { Element } from "../../../../models/Element";
import type { Affordance, ObserveResult, SkeletonElement } from "../../../../models/ObserveResult";
import { searchableNativeId } from "../../../utility/SearchableNode";
import type { ElementProvenance } from "../elementProvenance";
export type ObserveElements = NonNullable<ObserveResult["elements"]>;

/** A non-empty string value, or `undefined` (empty/whitespace/non-string reads as absent). */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * `elementId = resource-id ?? view-id`. The `view-id` slot is the stable
 * content-hash id from `assignStableViewIds` (`s-…`, #3228), so a row keeps its
 * elementId across a scroll. A test tag is carried separately for Compose
 * owners that do not enable `testTagsAsResourceId`.
 */
export function deriveId(el: Element): string | undefined {
  return searchableNativeId(el) ?? nonEmptyString(el["view-id"]);
}

/** Flatten an element's object bounds to the compact `[left, top, right, bottom]` tuple. */
export function boundsTuple(el: Element): SkeletonElement["bounds"] | undefined {
  const b = el.bounds;
  if (
    Array.isArray(b) &&
    b.length === 4 &&
    b.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    return [b[0], b[1], b[2], b[3]];
  }
  if (!b || typeof b !== "object") {
    return undefined;
  }
  const { left, top, right, bottom } = b;
  if ([left, top, right, bottom].some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    return undefined;
  }
  return [left, top, right, bottom];
}

/** Working accumulator for one merged skeleton row, keyed by `(elementId, label, bounds)`. */
export interface SkeletonAccumulator {
  elementId?: string;
  label?: string;
  editableHint?: string;
  /**
   * The hint is not already a searchable label source (Android: iOS puts it in the
   * searchable text fields), so a labelled field must surface it itself (#9346).
   */
  hintBesideLabel?: true;
  sublabel?: string;
  testTag?: string;
  semanticLinks?: SkeletonElement["semanticLinks"];
  bounds: SkeletonElement["bounds"];
  affordances: Set<Affordance>;
  checked?: boolean;
  /** AutoMobile prototype rows only: the selected tab or option, and the node's state description. */
  selected?: true;
  stateDescription?: string;
  enabled?: false;
  /** The Android IME or an application window covers every coordinate action on this app row. */
  occluded?: true;
  /** First element merged into this row; resolves its owning window for cover checks. */
  target?: Element;
  /**
   * Root/window ancestry, when the collector supplied it (issue #5881). Present
   * on real captures; absent on hand-built fixtures and non-provenance producers,
   * where hoisting/suppression fall back to geometric containment.
   */
  provenance?: ElementProvenance;
  /** Disambiguator assigned by {@link assignDuplicateIndexes} (issue #6221 item 2). */
  index?: number;
}

export function area(bounds: SkeletonElement["bounds"]): number {
  return Math.max(0, bounds[2] - bounds[0]) * Math.max(0, bounds[3] - bounds[1]);
}

/** Order two rows top-to-bottom, then left-to-right, by their bounds tuple. */
export function byReadingOrder(a: SkeletonAccumulator, b: SkeletonAccumulator): number {
  return a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0];
}

/** The smallest bounds tuple enclosing every supplied box. */
export function unionBounds(
  boxes: readonly NonNullable<SkeletonElement["bounds"]>[],
): SkeletonElement["bounds"] {
  let [left, top, right, bottom] = boxes[0];
  for (const box of boxes.slice(1)) {
    left = Math.min(left, box[0]);
    top = Math.min(top, box[1]);
    right = Math.max(right, box[2]);
    bottom = Math.max(bottom, box[3]);
  }
  return [left, top, right, bottom];
}

/** Every collected element, in the category order the projection consumes them. */
export function allElements(elements: ObserveElements): Element[] {
  return [...elements.clickable, ...elements.scrollable, ...elements.text];
}

export type Bounds = SkeletonElement["bounds"];
