import type { ElementBounds } from "../../models/ElementBounds";

/**
 * Host-owned identifiers of AutoMobile's own prototype window controls (#15120). Both platforms
 * draw the dismiss controls (close chip, dismiss bar button, chromeless escape pill) under the
 * same id; the iOS agent also marks a chromeless fullscreen root. Authored `testTag`s cannot take
 * the `automobile-` namespace (`PROTOTYPE_RESERVED_TEST_TAG_PREFIX`), so these never collide with
 * an authored node.
 */
export const PROTOTYPE_DISMISS_ID = "automobile-prototype-dismiss";
export const PROTOTYPE_WINDOW_MARKER_ID = "automobile-prototype-window";

/** Identifiers that mark the iOS agent's window; Android finds its window by window entry. */
export const PROTOTYPE_WINDOW_MARKER_IDENTIFIERS: readonly string[] = [
  PROTOTYPE_WINDOW_MARKER_ID,
  PROTOTYPE_DISMISS_ID,
];

/**
 * Whether a node's resource id is a host dismiss control. Only the bare id counts: Android exposes
 * the host's `testTag` unchanged, and the reserved `automobile-` prefix is enforced on authored
 * tags, so a package-qualified look-alike (`example:id/automobile-prototype-dismiss`) is an
 * authored node, not a host control.
 */
export function isPrototypeHostDismissId(resourceId: unknown): boolean {
  return resourceId === PROTOTYPE_DISMISS_ID;
}

/** Where a tap on a target may land once host dismiss controls are kept clear. */
export type HostControlTapDecision =
  | { kind: "proceed"; point: { x: number; y: number } }
  | { kind: "refuse"; control: string };

const WHOLE_PIXEL = 1;

function contains(bounds: ElementBounds, point: { x: number; y: number }): boolean {
  return (
    point.x >= bounds.left &&
    point.x < bounds.right &&
    point.y >= bounds.top &&
    point.y < bounds.bottom
  );
}

function area(bounds: ElementBounds): number {
  return Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
}

/** `bounds` minus `cut`: up to four disjoint strips (above, below, left and right of the cut). */
function subtract(bounds: ElementBounds, cut: ElementBounds): ElementBounds[] {
  const overlaps =
    cut.left < bounds.right &&
    cut.right > bounds.left &&
    cut.top < bounds.bottom &&
    cut.bottom > bounds.top;
  if (!overlaps) {
    return [bounds];
  }
  const middleTop = Math.max(bounds.top, cut.top);
  const middleBottom = Math.min(bounds.bottom, cut.bottom);
  return [
    { ...bounds, bottom: middleTop },
    { ...bounds, top: middleBottom },
    { left: bounds.left, right: cut.left, top: middleTop, bottom: middleBottom },
    { left: cut.right, right: bounds.right, top: middleTop, bottom: middleBottom },
  ].filter((strip) => area(strip) > 0);
}

/**
 * Keep a tap off AutoMobile's host dismiss controls. A control drawn over the target would take the
 * touch and dismiss the prototype instead of reaching the target, so a point inside one moves to
 * the centre of the largest visible part of the target outside every control, and a target with no
 * such part is refused by name. A target that is itself a host control (or lies inside one) is
 * tapped as asked.
 */
export function resolveTapOffHostControls(input: {
  controls: readonly { id: string; bounds: ElementBounds }[];
  targetId?: string;
  visibleBounds: ElementBounds;
  point: { x: number; y: number };
}): HostControlTapDecision {
  const { controls, targetId, visibleBounds, point } = input;
  if (isPrototypeHostDismissId(targetId)) {
    return { kind: "proceed", point };
  }
  const covering = controls.filter((control) => contains(control.bounds, point));
  if (covering.length === 0) {
    return { kind: "proceed", point };
  }
  const remaining = controls.reduce<ElementBounds[]>(
    (parts, control) => parts.flatMap((part) => subtract(part, control.bounds)),
    [visibleBounds],
  );
  const best = remaining.reduce<ElementBounds | undefined>(
    (largest, part) => (largest === undefined || area(part) > area(largest) ? part : largest),
    undefined,
  );
  if (best === undefined || area(best) < WHOLE_PIXEL) {
    return { kind: "refuse", control: covering[0].id };
  }
  return {
    kind: "proceed",
    point: {
      x: Math.floor((best.left + best.right - WHOLE_PIXEL) / 2),
      y: Math.floor((best.top + best.bottom - WHOLE_PIXEL) / 2),
    },
  };
}
