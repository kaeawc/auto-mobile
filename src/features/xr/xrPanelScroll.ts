import type { A11yActionResult } from "../observe/android/types";
import { ActionableError, type Element, type SwipeResult, type ObserveResult } from "../../models";
import { isTruthy } from "../../models/Element";
import { boundsNearlyEqual } from "../../utils/bounds";
import { throwIfAborted } from "../../utils/toolUtils";
import { linkWindowRoots } from "../observe/linkWindowRoots";
import { isCompleteHierarchy } from "../talkback/resourceIdActionError";
import { stableNodeSelectorForElement } from "../talkback/TalkBackTapStrategy";
import { hasAccessibilityAction } from "../utility/elementProperties";
import { SearchableHierarchy, matchesCtrlProxyNodeSelector } from "../utility/SearchableNode";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import { isVisibleAutoScrollTarget } from "../action/swipeon/SwipeOnAutoTargeting";
import {
  scrollActionForFingerDirection,
  type TalkBackSwipeCtrlProxy,
} from "../action/swipeon/TalkBackSwipeExecutor";
import { semanticScrollSuccess } from "../action/swipeon/swipeDurationReport";
import type { SwipeGestureRequest } from "../action/swipeon/types";
import { xrForegroundApp } from "./xrForegroundApp";
import { assertXrSwipeDisplayInputSupported, isXrSpatialPanelApp } from "./xrSpatialPanelInput";

/** Embedded panels accept accessibility scrolls only; a refusal never permits a display gesture. */
export async function executeXrPanelScroll(
  service: Pick<TalkBackSwipeCtrlProxy, "supportsNodeActionSelectors" | "requestNodeAction">,
  request: SwipeGestureRequest,
  androidXr: boolean,
): Promise<SwipeResult | undefined> {
  const { observation, direction, containerElement, gestureOptions, signal, perf } = request;
  if (!observation || !isXrSpatialPanelApp(observation, androidXr)) {
    return undefined;
  }
  throwIfAborted(signal);
  const action = scrollActionForFingerDirection(direction);
  const target = resolvePanelScrollTarget(observation, containerElement, action);
  if (!target) {
    return undefined;
  }
  if (!(await service.supportsNodeActionSelectors(perf, signal, true))) {
    throw new ActionableError(
      "Update CtrlProxy: XR panel scrolling requires verified accessibility node bounds.",
    );
  }
  throwIfAborted(signal);
  gestureOptions?.displayFence?.assertCurrent();
  if (gestureOptions?.searchDragState) {
    gestureOptions.searchDragState.pagingStep = true;
  }
  const result = await service.requestNodeAction(action, target.selector, {
    expectedBounds: target.expectedBounds,
    signal,
    perf,
  });
  throwIfAborted(signal);
  return panelScrollResult(result, request);
}

function panelScrollResult(result: A11yActionResult, request: SwipeGestureRequest): SwipeResult {
  const { gestureOptions, x1, y1, x2, y2 } = request;
  const failure: SwipeResult = {
    success: false,
    x1,
    y1,
    x2,
    y2,
    duration: gestureOptions?.duration || 300,
    error:
      "The XR panel cannot scroll further in that direction or its layout changed. Observe again before retrying.",
  };
  if (result.success) {
    const success = semanticScrollSuccess({ x1, y1, x2, y2 }, gestureOptions);
    return {
      ...success,
      warnings: [
        "Scrolled the XR panel with an accessibility node action." +
          (gestureOptions?.durationExplicit
            ? " durationMs was ignored: a node scroll has no timed stroke; the reported duration is nominal."
            : ""),
        ...(request.boomerang
          ? ["Boomerang has no return stroke on an XR spatial panel; performed one node scroll."]
          : []),
      ],
    };
  }
  if (result.dispatched && result.acknowledged !== true) {
    return {
      ...failure,
      outcomeIndeterminate: true,
      retryable: false,
      error: `Swipe outcome is indeterminate: the node scroll was dispatched but no result was confirmed (${result.error ?? "no reply from CtrlProxy"}). Do not retry automatically.`,
    };
  }
  return failure;
}

function panelScrollRefusal(): ActionableError {
  return new ActionableError(
    "The XR panel cannot scroll further in that direction or its layout changed. Observe again before retrying.",
  );
}

function resolvePanelScrollTarget(
  observation: ObserveResult,
  containerElement: Element | null,
  action: "scroll_forward" | "scroll_backward",
):
  | { selector: ReturnType<typeof stableNodeSelectorForElement>; expectedBounds: Element["bounds"] }
  | undefined {
  const hierarchy = resolveViewHierarchyForSearch(observation.viewHierarchy) ?? null;
  if (!isCompleteHierarchy(hierarchy)) {
    assertXrSwipeDisplayInputSupported(observation, true);
    return undefined;
  }
  const windows = linkWindowRoots(hierarchy.hierarchy, hierarchy.windows);
  const search = new SearchableHierarchy();
  const entries = search.project({ ...hierarchy, windows });
  const packageName = xrForegroundApp(observation);
  const appSources = new Set(
    search
      .project({
        hierarchy: {},
        windows: windows?.filter(
          (window) =>
            window.type === 1 &&
            window.packageName === packageName &&
            !window.packageName?.startsWith("com.android.systemui"),
        ),
      })
      .map((entry) => entry.source),
  );
  const appEntries = entries.filter(
    (entry) =>
      appSources.has(entry.source) &&
      entry.bounds &&
      isVisibleAutoScrollTarget(entry.properties, true),
  );
  const advertisesScroll = (element: Element) =>
    hasAccessibilityAction(element.actions, "scroll_forward") ||
    hasAccessibilityAction(element.actions, "scroll_backward");
  const eligible = appEntries.filter((entry) => advertisesScroll(entry.properties));
  const supplied =
    containerElement &&
    appEntries.find(
      (entry) =>
        (isTruthy(entry.properties.scrollable) || advertisesScroll(entry.properties)) &&
        boundsNearlyEqual(entry.bounds!, containerElement.bounds, 0) &&
        (containerElement["view-id"]
          ? entry.properties["view-id"] === containerElement["view-id"]
          : containerElement["resource-id"] === entry.properties["resource-id"]),
    );
  const area = (bounds: Element["bounds"]) =>
    (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
  const target = supplied || eligible.sort((a, b) => area(b.bounds!) - area(a.bounds!))[0];
  if (!target) {
    assertXrSwipeDisplayInputSupported(observation, true);
    return undefined;
  }
  if (!hasAccessibilityAction(target.properties.actions, action)) {
    throw panelScrollRefusal();
  }
  const selector = stableNodeSelectorForElement(target.properties);
  const matches = entries.filter((entry) =>
    selector
      ? matchesCtrlProxyNodeSelector(entry.properties, selector)
      : entry.bounds &&
        boundsNearlyEqual(entry.bounds, target.bounds!, 0) &&
        hasAccessibilityAction(entry.properties.actions, action),
  );
  if (
    new Set(matches.map((entry) => entry.source)).size !== 1 ||
    !matches[0]?.bounds ||
    !boundsNearlyEqual(matches[0].bounds, target.bounds!, 0)
  ) {
    throw panelScrollRefusal();
  }
  return { selector, expectedBounds: target.bounds! };
}
