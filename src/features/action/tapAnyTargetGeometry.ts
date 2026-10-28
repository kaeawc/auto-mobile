import { type CapturedTapTarget } from "./TapAnyAndroidTapper";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import {
  ActionableError,
  type AndroidOrIosPlatform,
  Element,
  TapAnyElementOptions,
  ViewHierarchyResult,
} from "../../models";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import {
  visibleTapBounds,
  hasVisibleScreenPart,
  screenSizeForOffscreenCheck,
  type ScreenSizeForOffscreenCheckOptions,
} from "../utility/ElementGeometry";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import { scopeHierarchyForSelector } from "../observe/hierarchyLayer";
import { ownPrototypeSafeGesturePoint } from "../observe/ApplicationWindowCover";

export function findTapAnyClickableElement(
  context: {
    elementSelector: ElementSelector;
    isContainerAvailable: (
      hierarchy: ViewHierarchyResult,
      container?: ElementContainerSelector,
    ) => boolean;
    platform: AndroidOrIosPlatform;
    iosMultiPanel: boolean;
  },
  options: TapAnyElementOptions,
  viewHierarchy: ViewHierarchyResult,
  sizeOptions: ScreenSizeForOffscreenCheckOptions = {},
): { element: Element | null; containerFound: boolean } {
  viewHierarchy = scopeHierarchyForSelector(viewHierarchy, options.layer);
  const containerFound = context.isContainerAvailable(viewHierarchy, options.container);
  const screenSizeOptions = {
    ...sizeOptions,
    platform: context.platform,
    iosMultiPanel: context.iosMultiPanel,
  };
  const effectiveScreenSize = screenSizeForOffscreenCheck(viewHierarchy, screenSizeOptions);
  const selection = context.elementSelector.select(
    viewHierarchy,
    {},
    {
      screenSizeOptions,
      container: options.container,
      strategy: options.selectionStrategy,
      intentAction: options.action === "longPress" ? "long-press" : "tap",
      scrollableContainer: options.scrollableContainer,
    },
  );
  if (selection.element && !hasVisibleScreenPart(selection.element.bounds, effectiveScreenSize)) {
    return { element: null, containerFound };
  }
  return { element: selection.element, containerFound };
}

export function resolveTapAnyPoint(
  context: {
    geometry: ElementGeometry;
    platform: AndroidOrIosPlatform;
    iosMultiPanel: boolean;
  },
  target: CapturedTapTarget,
  sizeOptions: ScreenSizeForOffscreenCheckOptions = {},
): { x: number; y: number } {
  const screenSize = screenSizeForOffscreenCheck(target.capture.hierarchy, {
    observationScreenSize: target.observationScreenSize,
    display: target.observationDisplay,
    ...sizeOptions,
    platform: context.platform,
    iosMultiPanel: context.iosMultiPanel,
  });
  const bounds = visibleTapBounds(target.element.bounds, screenSize);
  if (!bounds) {
    throw new ActionableError(
      "Matched element has no visible tap area; scroll it into view, then retry tapAny.",
    );
  }
  const center = context.geometry.getElementCenter({ bounds });
  if (target.layer !== undefined || context.platform === "ios") {
    return center;
  }
  // Default-layer selectors also resolve app rows kept under AutoMobile's own prototype (#10691),
  // so avoid the prototype as tapOn does; layer "app" refuses later with its own error.
  const safe = ownPrototypeSafeGesturePoint(
    target.capture.hierarchy,
    target.element,
    bounds,
    center,
  );
  if (!safe) {
    throw new ActionableError(
      "Target is covered by an AutoMobile prototype window; hide or move the prototype, then retry tapAny.",
    );
  }
  return safe;
}
