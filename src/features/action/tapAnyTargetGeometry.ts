import { boundsArea, boundsEqual, intersectBounds } from "../../utils/bounds";
import { withoutHiddenXrChrome } from "./xrHiddenChrome";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";
import { promoteClickableAncestor } from "../utility/ElementResolverNodes";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { DefaultElementParser } from "../utility/ElementParser";
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
    xr?: boolean;
  },
  options: TapAnyElementOptions,
  viewHierarchy: ViewHierarchyResult,
  sizeOptions: ScreenSizeForOffscreenCheckOptions = {},
): { element: Element | null; containerFound: boolean } {
  viewHierarchy = scopeHierarchyForSelector(viewHierarchy, options.layer);
  if (context.xr) {
    viewHierarchy = xrTapAnyHierarchy(viewHierarchy, options);
  }
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
      readingOrder: context.xr,
      screenSizeOptions,
      container: options.container,
      strategy: options.selectionStrategy,
      intentAction: options.action === "longPress" ? "long-press" : "tap",
      scrollableContainer: options.scrollableContainer,
    },
  );
  if (context.xr && !selection.element && options.container) {
    selection.element = xrContainerOwner(
      context.elementSelector,
      viewHierarchy,
      options,
      effectiveScreenSize,
    );
  }
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

/** Prefer the foreground app's controls to its separate, window-local caption buttons. */
function xrTapAnyHierarchy(
  viewHierarchy: ViewHierarchyResult,
  options: TapAnyElementOptions,
): ViewHierarchyResult {
  viewHierarchy = withoutHiddenXrChrome(viewHierarchy).hierarchy;
  const appWindows = viewHierarchy.windows?.filter(
    (window) =>
      window.hierarchy &&
      window.packageName === viewHierarchy.packageName &&
      !window.packageName?.startsWith("com.android.systemui"),
  );
  if (!options.container && appWindows?.length) {
    viewHierarchy = {
      ...viewHierarchy,
      hierarchy: {
        node: {
          node: appWindows.flatMap((window) => (window.hierarchy ? [window.hierarchy] : [])),
        },
      },
      windows: appWindows,
    };
  }
  return viewHierarchy;
}

function xrContainerOwner(
  selector: ElementSelector,
  viewHierarchy: ViewHierarchyResult,
  options: TapAnyElementOptions,
  viewport: { width: number; height: number } | undefined,
): Element | null {
  const container = selector.resolveContainer?.(viewHierarchy, options.container!);
  const source = container && getHierarchyNodeSource(container);
  const nodes = new SearchableHierarchy().project(viewHierarchy);
  const node = nodes.find((entry) => entry.source === source);
  if (!node?.bounds || nodes.some((entry) => entry.parentIndex === node.index)) {
    return null;
  }
  const area = boundsArea(node.bounds);
  if (area <= 0) {
    return null;
  }
  const owner = promoteClickableAncestor(
    node,
    nodes,
    { action: options.action === "longPress" ? "long-press" : "tap", viewport },
    xrContainerScope(node, nodes, area),
  );
  if (owner) {
    return new DefaultElementParser().parseNodeBounds(owner.source);
  }
  return null;
}

/** Promotion's inclusive boundary: three ancestors, small bounds, and no full-window root. */
function xrContainerScope(
  node: SearchableEntry,
  nodes: readonly SearchableEntry[],
  area: number,
): SearchableEntry {
  const root = nodes.findLast(
    (entry) =>
      entry.index <= node.index &&
      entry.rootGroup === node.rootGroup &&
      entry.parentIndex === undefined,
  );
  const rootBounds = root?.bounds;
  let scope = node;
  for (let level = 0; level < 3 && scope.parentIndex !== undefined; level++) {
    const parent = nodes[scope.parentIndex];
    if (parent === root || !parent.bounds || boundsArea(parent.bounds) > 4 * area) {
      break;
    }
    const overlap = rootBounds ? intersectBounds(parent.bounds, rootBounds) : null;
    if (overlap && rootBounds && boundsEqual(overlap, rootBounds)) {
      break;
    }
    scope = parent;
  }
  return scope;
}
