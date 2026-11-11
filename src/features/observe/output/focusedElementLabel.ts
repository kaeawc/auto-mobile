/**
 * The label of a focused element whose text sits on a child (#18028). A Compose TV card or a
 * Leanback ImageCardView takes focus on a container with no text or content-desc; its title is a
 * descendant. The skeleton already hoists that text onto the container's row, so the focused
 * element takes the label of the row with its bounds and id, as `descendantLabel` (the name
 * focusNavigate's path entries use for the same thing). Only a label some element inside the focused
 * bounds carries as its text or content-desc counts: a text field's row label can be its hint or
 * value, which is not a child label.
 */

import type { Element } from "../../../models/Element";
import type { ObserveResult, SkeletonElement } from "../../../models/ObserveResult";
import { isEditableElementProperties } from "../../utility/elementProperties";
import { allElements, boundsTuple } from "./skeletonProjection/rowModel";

function ownLabel(element: Element): string | undefined {
  const label = [element.text, element["content-desc"]].find(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  return typeof label === "string" ? label : undefined;
}

function sameBounds(a: readonly number[], b: readonly number[]): boolean {
  return a.every((value, index) => value === b[index]);
}

function inside(inner: readonly number[], outer: readonly number[]): boolean {
  const [left, top, right, bottom] = inner;
  return left >= outer[0] && top >= outer[1] && right <= outer[2] && bottom <= outer[3];
}

/** Whether an element other than the focused one, inside its bounds, shows `label`. */
function shownInside(
  label: string,
  bounds: readonly number[],
  focused: Element,
  elements: readonly Element[],
): boolean {
  const wanted = label.trim();
  return elements.some((element) => {
    const own = boundsTuple(element);
    return (
      element !== focused &&
      own !== undefined &&
      inside(own, bounds) &&
      ownLabel(element)?.trim() === wanted
    );
  });
}

/** Whether the focused element still needs a label from its descendants; never a text field. */
export function needsDescendantLabel(focused: Element | undefined): focused is Element {
  return (
    focused !== undefined &&
    ownLabel(focused) === undefined &&
    !focused.descendantLabel &&
    !isEditableElementProperties(focused)
  );
}

/**
 * The skeleton row label for a focused element without its own text or content-desc: the row at
 * the same bounds whose `elementId`, when both have one, is the element's `resource-id ??
 * view-id`, and whose label an element inside those bounds shows. Undefined when the element is
 * labelled itself, is a text field, or no labelled row is it.
 */
export function focusedDescendantLabel(
  focused: Element,
  rows: readonly SkeletonElement[],
  elements: readonly Element[],
): string | undefined {
  const bounds = boundsTuple(focused);
  if (!needsDescendantLabel(focused) || !bounds) {
    return undefined;
  }
  const id = focused["resource-id"] || focused["view-id"];
  const row = rows.find(
    (candidate) =>
      candidate.label !== undefined &&
      candidate.label.trim().length > 0 &&
      sameBounds(candidate.bounds, bounds) &&
      (candidate.elementId === undefined || !id || candidate.elementId === id) &&
      shownInside(candidate.label, bounds, focused, elements),
  );
  return row?.label;
}

/** The flat element list of an observation's categorized `elements`. */
export function observedElements(source: ObserveResult): Element[] {
  return source.elements ? allElements(source.elements) : [];
}

/**
 * Set `out.focusedElement.descendantLabel` from `rows`, checked against `elements`, when the
 * element has no label of its own.
 */
export function labelFocusedElement(
  out: ObserveResult,
  rows: readonly SkeletonElement[],
  elements: readonly Element[],
): void {
  const focused = out.focusedElement;
  if (!needsDescendantLabel(focused)) {
    return;
  }
  const label = focusedDescendantLabel(focused, rows, elements);
  if (label !== undefined) {
    out.focusedElement = { ...focused, descendantLabel: label };
  }
}
