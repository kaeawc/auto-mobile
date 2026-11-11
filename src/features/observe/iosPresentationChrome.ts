import type { Affordance, ElementBounds, ScreenSize } from "../../models";

/** Unnamed tap-only artwork overflowing multiple screen edges is iOS presentation chrome. */
export function isIosPresentationChrome(
  node: {
    affordances: Iterable<Affordance>;
    label?: string;
    sublabel?: string;
    nativeId?: string;
    testTag?: string;
    bounds?: ElementBounds;
  },
  screen: ScreenSize | undefined,
): boolean {
  // A zero-sized fallback is not evidence that artwork extends off screen.
  if (!screen || Math.min(screen.width, screen.height) <= 0 || !node.bounds) {
    return false;
  }
  const affordances = [...node.affordances];
  if (
    affordances.length !== 1 ||
    affordances[0] !== "tap" ||
    node.label !== undefined ||
    node.sublabel !== undefined ||
    node.nativeId !== undefined ||
    node.testTag !== undefined
  ) {
    return false;
  }
  const { left, top, right, bottom } = node.bounds;
  return (
    [left < 0, top < 0, right > screen.width, bottom > screen.height].filter(Boolean).length >= 2
  );
}
