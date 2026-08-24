import type { Element } from "../../models/Element";
import type { ElementSelector as FocusElementSelector } from "./ElementSelector";
import { FocusElementMatcher } from "./FocusElementMatcher";

export interface FocusNavigationPath {
  currentFocusIndex: number | null;
  targetFocusIndex: number;
  swipeCount: number;
  direction: "forward" | "backward";
}

export class FocusPathCalculator {
  private matcher: FocusElementMatcher;

  constructor(matcher: FocusElementMatcher = new FocusElementMatcher()) {
    this.matcher = matcher;
  }

  calculatePath(
    currentFocus: Element | null,
    targetSelector: FocusElementSelector,
    orderedElements: Element[],
  ): FocusNavigationPath | null {
    if (!orderedElements.length) {
      return null;
    }

    const targetIndex = this.matcher.findTargetIndex(orderedElements, targetSelector);
    if (targetIndex === null) {
      return null;
    }

    // When the cursor can't be located in the traversal order, plan a forward
    // sweep from the start — the reasonable default for "no focus yet". The
    // unresolved state is surfaced as `currentFocusIndex: null` so the executor
    // can guard against a non-converging march (see FocusNavigationExecutor, #3917).
    const resolvedCurrentIndex = this.matcher.findCurrentFocusIndex(currentFocus, orderedElements);
    const currentIndex = resolvedCurrentIndex ?? 0;

    const boundedCurrentIndex = this.clampIndex(currentIndex, orderedElements.length);
    const swipeCount = Math.abs(targetIndex - boundedCurrentIndex);
    const direction: "forward" | "backward" =
      targetIndex >= boundedCurrentIndex ? "forward" : "backward";

    return {
      currentFocusIndex: resolvedCurrentIndex,
      targetFocusIndex: targetIndex,
      swipeCount,
      direction,
    };
  }

  private clampIndex(index: number, length: number): number {
    if (!Number.isFinite(index)) {
      return 0;
    }
    if (index < 0) {
      return 0;
    }
    if (index >= length) {
      return Math.max(0, length - 1);
    }
    return Math.floor(index);
  }
}
