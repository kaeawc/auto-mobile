import { Element, ObserveResult, ViewHierarchyResult } from "../../../models";
import type { ElementGeometry } from "../../../utils/interfaces/ElementGeometry";
import { insetSwipeBounds, iosSwipeStartWarning } from "./iosChromeInsets";
import type { OverlayAnalyzer, SwipeOnResolvedOptions } from "./types";

export function resolveContainerSwipeCoordinates({
  geometry,
  overlayDetector,
  options,
  viewHierarchy,
  containerElement,
  observeResult,
  platform,
}: {
  geometry: ElementGeometry;
  overlayDetector: OverlayAnalyzer;
  options: SwipeOnResolvedOptions;
  viewHierarchy: ViewHierarchyResult;
  containerElement: Element;
  observeResult: ObserveResult;
  platform?: "android" | "ios";
}): { startX: number; startY: number; endX: number; endY: number; warning?: string } {
  const insetOptions = {
    observation: observeResult,
    platform,
    includeSystemInsets: options.includeSystemInsets,
  };
  const effectiveBounds = insetSwipeBounds({ ...insetOptions, bounds: containerElement.bounds });
  const withChromeWarning = (swipe: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    warning?: string;
  }) => {
    const warning = iosSwipeStartWarning({ ...insetOptions, ...swipe });
    return warning
      ? { ...swipe, warning: [swipe.warning, warning].filter(Boolean).join(" ") }
      : swipe;
  };

  const defaultSwipe = geometry.getSwipeWithinBounds(options.direction, effectiveBounds);

  const overlayCandidates = overlayDetector.collectOverlayCandidates(
    viewHierarchy,
    containerElement,
  );
  if (overlayCandidates.length === 0) {
    return withChromeWarning(defaultSwipe);
  }

  const allOverlayBounds = overlayCandidates.map((overlay) => overlay.overlapBounds);
  const safeSwipe = overlayDetector.computeSafeSwipeCoordinates(
    options.direction,
    effectiveBounds,
    allOverlayBounds,
  );

  if (!safeSwipe) {
    return withChromeWarning({
      ...defaultSwipe,
      warning: "No unobstructed swipe area found; using container bounds.",
    });
  }

  return withChromeWarning(safeSwipe);
}
