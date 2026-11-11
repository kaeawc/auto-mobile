import { Element, type ElementBounds, ObserveResult, ViewHierarchyResult } from "../../../models";
import type { ScreenSize } from "../../../models/ScreenSize";
import type { ElementGeometry } from "../../../utils/interfaces/ElementGeometry";
import { getScreenBounds } from "../../../utils/screenBounds";
import { getHierarchySnapshot } from "../../observe/HierarchyCapture";
import { insetSwipeBounds, iosSwipeStartWarning, swipeScreenSize } from "./iosChromeInsets";
import type { OverlayAnalyzer, SwipeOnResolvedOptions } from "./types";

const IOS_DRAG_HANDLE_MAX_EXTENT_POINTS = 48;
const IOS_DRAG_HANDLE_TRAVEL_POINTS = 240;
const IOS_DRAG_HANDLE_MIN_TRAVEL_POINTS = 120;

/** A thin handle needs a pan beyond its own bounds to move the sheet it controls. */
function iosDragHandleSwipe({
  direction,
  bounds,
  screen,
}: {
  direction: SwipeOnResolvedOptions["direction"];
  bounds: ElementBounds;
  screen: ScreenSize;
}) {
  const vertical = direction === "up" || direction === "down";
  const extent = vertical ? bounds.bottom - bounds.top : bounds.right - bounds.left;
  if (extent >= IOS_DRAG_HANDLE_MAX_EXTENT_POINTS) {
    return undefined;
  }
  const startX = Math.floor((bounds.left + bounds.right) / 2);
  const startY = Math.floor((bounds.top + bounds.bottom) / 2);
  const travel =
    direction === "up" || direction === "left"
      ? -IOS_DRAG_HANDLE_TRAVEL_POINTS
      : IOS_DRAG_HANDLE_TRAVEL_POINTS;
  const screenBounds = getScreenBounds(screen);
  const endX = Math.floor(
    Math.max(screenBounds.left, Math.min(screenBounds.right, startX + (vertical ? 0 : travel))),
  );
  const endY = Math.floor(
    Math.max(screenBounds.top, Math.min(screenBounds.bottom, startY + (vertical ? travel : 0))),
  );
  const distance = vertical ? Math.abs(endY - startY) : Math.abs(endX - startX);
  const warning = `Container is only ${extent} pt along the swipe axis, so the swipe starts at its centre and travels ${distance} pt in the swipe direction, like dragging a sheet grabber.`;
  return {
    startX,
    startY,
    endX,
    endY,
    warning:
      distance < IOS_DRAG_HANDLE_MIN_TRAVEL_POINTS
        ? `${warning} Screen bounds leave less than ${IOS_DRAG_HANDLE_MIN_TRAVEL_POINTS} pt of travel; the drag may be too short.`
        : warning,
  };
}

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

  if ((platform ?? getHierarchySnapshot(observeResult.viewHierarchy)?.platform) === "ios") {
    const handleSwipe = iosDragHandleSwipe({
      direction: options.direction,
      bounds: effectiveBounds,
      screen: swipeScreenSize(insetOptions) ?? observeResult.screenSize,
    });
    if (handleSwipe) {
      return withChromeWarning(handleSwipe);
    }
  }

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
