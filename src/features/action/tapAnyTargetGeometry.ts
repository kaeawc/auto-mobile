import { boundsArea, intersectBounds, parseBounds } from "../../utils/bounds";
import { withoutHiddenXrChrome } from "./xrHiddenChrome";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";
import { isWithin, promoteClickableAncestor } from "../utility/ElementResolverNodes";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { DefaultElementParser } from "../utility/ElementParser";
import { type CapturedTapTarget } from "./TapAnyAndroidTapper";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import {
  ActionableError,
  type AndroidOrIosPlatform,
  Element,
  type ElementBounds,
  TapAnyElementOptions,
  ViewHierarchyResult,
  type ViewHierarchyWindowInfo,
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
import { ownPrototypeSafeGesturePoint, uniqueBySource } from "../observe/ApplicationWindowCover";
import { ownPrototypeWindows } from "../observe/ownWindowFocus";

const ACCESSIBILITY_WINDOW_TYPE_APPLICATION = 1;

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

/**
 * Prefer application windows to SystemUI's separate, window-local caption buttons. A window of
 * another package stays only when it is an application window that overlaps one of the capture
 * package's windows, so window ranking puts a higher-layer dialog from another package (a
 * permission prompt) ahead of the pane behind it while a separate panel beside it (another app)
 * cannot win. A window without a package is foreign here: its type decides, so a package-less IME
 * window is dropped.
 */
function xrTapAnyHierarchy(
  viewHierarchy: ViewHierarchyResult,
  options: TapAnyElementOptions,
): ViewHierarchyResult {
  viewHierarchy = withoutHiddenXrChrome(viewHierarchy).hierarchy;
  const prototypes = new Set(ownPrototypeWindows(viewHierarchy));
  const isOwn = (window: ViewHierarchyWindowInfo) =>
    window.packageName !== undefined && window.packageName === viewHierarchy.packageName;
  const candidates =
    viewHierarchy.windows?.filter(
      (window) =>
        window.hierarchy !== undefined &&
        !prototypes.has(window) &&
        !window.packageName?.startsWith("com.android.systemui") &&
        (isOwn(window) ||
          window.type === undefined ||
          window.type === ACCESSIBILITY_WINDOW_TYPE_APPLICATION),
    ) ?? [];
  const ownBounds = candidates.filter(isOwn).flatMap((window) => parseBounds(window.bounds) ?? []);
  const appWindows = candidates.filter(
    (window) => isOwn(window) || overlapsOwnWindow(window, ownBounds),
  );
  if (!options.container && appWindows.length) {
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

/** Without bounds on either side, overlap is unknown and the window stays. */
function overlapsOwnWindow(
  window: ViewHierarchyWindowInfo,
  ownBounds: readonly ElementBounds[],
): boolean {
  const bounds = parseBounds(window.bounds);
  return !bounds || ownBounds.length === 0 || ownBounds.some((own) => intersectBounds(bounds, own));
}

function xrContainerOwner(
  selector: ElementSelector,
  viewHierarchy: ViewHierarchyResult,
  options: TapAnyElementOptions,
  viewport: { width: number; height: number } | undefined,
): Element | null {
  const nodes = new SearchableHierarchy().project(viewHierarchy);
  const node = leafContainerEntry(
    nodes,
    resolvedSource(selector, viewHierarchy, options.container),
  );
  if (!node) {
    return null;
  }
  // A nested selector's outer container bounds the promotion too: the owner stays inside it.
  const boundary = resolvedSource(selector, viewHierarchy, options.container!.container);
  const owner = promoteClickableAncestor(
    node,
    nodes,
    { action: options.action === "longPress" ? "long-press" : "tap", viewport },
    xrContainerScope(node, nodes, viewport, boundary),
  );
  if (!owner || (options.scrollableContainer && !withinScrollingRoot(owner, nodes))) {
    return null;
  }
  return new DefaultElementParser().parseNodeBounds(owner.source);
}

function resolvedSource(
  selector: ElementSelector,
  viewHierarchy: ViewHierarchyResult,
  container: ElementContainerSelector | undefined,
): SearchableEntry["source"] | undefined {
  const element = container && selector.resolveContainer?.(viewHierarchy, container);
  return element ? getHierarchyNodeSource(element) : undefined;
}

/** The container's entry when it is a leaf with a positive area, otherwise undefined. */
function leafContainerEntry(
  nodes: readonly SearchableEntry[],
  source: SearchableEntry["source"] | undefined,
): SearchableEntry | undefined {
  // Live captures share nodes between the merged roots and each window; resolve the owning
  // window's copy so the scope is bounded by that window's root, not the merged wrapper.
  const node = source && uniqueBySource(nodes).find((entry) => entry.source === source);
  if (
    !node?.bounds ||
    boundsArea(node.bounds) <= 0 ||
    nodes.some((entry) => entry.parentIndex === node.index)
  ) {
    return undefined;
  }
  return node;
}

/** `scrollableContainer` admits only owners inside a scrolling root, as the selector does. */
function withinScrollingRoot(node: SearchableEntry, nodes: readonly SearchableEntry[]): boolean {
  for (let entry: SearchableEntry | undefined = node; entry;) {
    if (entry.affordances.includes("scroll")) {
      return true;
    }
    entry = entry.parentIndex === undefined ? undefined : nodes[entry.parentIndex];
  }
  return false;
}

/**
 * Bound leaf ownership to three ancestors, a quarter window, the enclosing container (when the
 * selector nests one; that container itself may own the leaf), and no unrelated controls.
 */
function xrContainerScope(
  node: SearchableEntry,
  nodes: readonly SearchableEntry[],
  viewport: { width: number; height: number } | undefined,
  boundary?: SearchableEntry["source"],
): SearchableEntry {
  const root = nodes.findLast(
    (entry) =>
      entry.index <= node.index &&
      entry.rootGroup === node.rootGroup &&
      entry.parentIndex === undefined,
  );
  const rootBounds =
    root?.bounds ??
    (viewport && {
      left: 0,
      top: 0,
      right: viewport.width,
      bottom: viewport.height,
    });
  const windowArea = rootBounds ? boundsArea(rootBounds) : 0;
  const chain = new Set([node.index]);
  let scope = node;
  for (let level = 0; level < 3 && scope.parentIndex !== undefined; level++) {
    const parent = nodes[scope.parentIndex];
    if (parent === root || !parent.bounds || boundsArea(parent.bounds) > windowArea / 4) {
      break;
    }
    if (
      nodes.some(
        (entry) =>
          !chain.has(entry.index) &&
          entry.affordances.some((action) => action === "tap" || action === "toggle") &&
          isWithin(entry, parent, nodes),
      )
    ) {
      break;
    }
    chain.add(parent.index);
    scope = parent;
    if (parent.source === boundary) {
      // The outer container may itself be the clickable row; nothing above it qualifies.
      break;
    }
  }
  return scope;
}
