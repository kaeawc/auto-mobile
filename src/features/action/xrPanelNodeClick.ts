import { ActionableError, type Element, type ViewHierarchyResult } from "../../models";
import { boundsNearlyEqual } from "../../utils/bounds";
import { throwIfAborted } from "../../utils/toolUtils";
import { StaleDisplayError } from "../observe/StaleDisplayError";
import { isCompleteHierarchy } from "../talkback/resourceIdActionError";
import { stableNodeSelectorForElement } from "../talkback/TalkBackTapStrategy";
import { hasAccessibilityAction } from "../utility/elementProperties";
import {
  SearchableHierarchy,
  matchesCtrlProxyNodeSelector,
  type SearchableEntry,
} from "../utility/SearchableNode";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import type { DisplayFenceOption } from "./BaseVisualChange";
import type { TapOnCtrlProxy } from "./tapHierarchyRead";
import { findTapTargetNode } from "./tapTargetSupport";
import type { AndroidActionRequestOptions } from "../observe/android/AndroidActionDispatcher";

type VerifiedNodeTarget = {
  selector?: NonNullable<ReturnType<typeof stableNodeSelectorForElement>>;
  expectedBounds: Element["bounds"];
  identityHints?: AndroidActionRequestOptions["identityHints"];
};

type XrNodeClickOptions = DisplayFenceOption & {
  resolvedHierarchy?: ViewHierarchyResult;
  onTalkBackActivation?: () => void;
  /** Set for container-scoped selections; ancestor activation never leaves it. */
  container?: unknown;
};

/** Resolves the requested container in the click's hierarchy. */
type XrContainerResolver = (hierarchy: ViewHierarchyResult) => Element | undefined;

export function xrCoordinateError(): ActionableError {
  return new ActionableError(
    "The element's bounds are in an XR panel coordinate space and are not tappable screen coordinates. A safe accessibility node click is unavailable. Use tapAt with screen coordinates from the screenshot instead.",
  );
}

/**
 * Only captured node fields identify the click; a tapped descendant can supply its label.
 * The extractor maps generic classes (View, FrameLayout, ScrollView, TextView) to a null
 * class, so the class hint is omitted then and CtrlProxy matches any class. The click
 * refuses only when no hint at all would constrain the live node.
 */
function xrNodeIdentityHints(
  captured: Element,
  label?: Element,
): AndroidActionRequestOptions["identityHints"] {
  const rawClassName = captured.class ?? captured.className;
  const ownLabeled = Boolean(captured.text || captured["content-desc"]);
  const labelSource = ownLabeled ? undefined : label;
  const hints = {
    className: typeof rawClassName === "string" ? nonEmpty(rawClassName) : undefined,
    text: nonEmpty(captured.text),
    contentDesc: nonEmpty(captured["content-desc"]),
    labelText: nonEmpty(labelSource?.text),
    labelContentDesc: nonEmpty(labelSource?.["content-desc"]),
  };
  return Object.values(hints).some((value) => value !== undefined) ? hints : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value || undefined;
}

function xrNodeClickSelector(
  action: string,
  element: Element,
  options: XrNodeClickOptions,
  resolveContainer?: XrContainerResolver,
): VerifiedNodeTarget {
  const hierarchy = resolveViewHierarchyForSearch(options.resolvedHierarchy) ?? null;
  if (
    action !== "tap" ||
    element["hierarchy-source"] === "uiautomator" ||
    !element.bounds ||
    !isCompleteHierarchy(hierarchy)
  ) {
    throw xrCoordinateError();
  }
  const entries = new SearchableHierarchy().project(hierarchy);
  const scope = xrClickScope(entries, element, options, { hierarchy, resolveContainer });
  // Native selectors are global across windows, including for an ancestor click.
  const uniqueSelector = (candidate: Element, label?: Element) => {
    const selector = stableNodeSelectorForElement(candidate);
    if (!selector) {
      const matches = entries.filter(
        (entry) =>
          entry.bounds &&
          boundsNearlyEqual(entry.bounds, candidate.bounds, 0) &&
          hasAccessibilityAction(entry.properties.actions, "click"),
      );
      // CtrlProxy resolves a bounds-only click across every window, so the one node at those
      // bounds must also sit strictly inside a requested container.
      if (
        new Set(matches.map((entry) => entry.source)).size !== 1 ||
        !isInsideScope(entries, matches[0], scope)
      ) {
        return undefined;
      }
      const identityHints = xrNodeIdentityHints(matches[0].properties, label);
      if (!identityHints) {
        return undefined;
      }
      return {
        expectedBounds: candidate.bounds,
        identityHints,
      };
    }
    const matches = entries.filter((entry) =>
      matchesCtrlProxyNodeSelector(entry.properties, selector),
    );
    return new Set(matches.map((entry) => entry.source)).size === 1 &&
      matches[0]?.bounds &&
      boundsNearlyEqual(matches[0].bounds, candidate.bounds, 0)
      ? { selector, expectedBounds: candidate.bounds }
      : undefined;
  };
  if (hasAccessibilityAction(element.actions, "click")) {
    const selector = uniqueSelector(element);
    if (selector) {
      return selector;
    }
    throw xrCoordinateError();
  }

  return xrAncestorClickSelector(element, entries, uniqueSelector, scope);
}

/** A label container may identify its owning row, while unrelated targets stay scoped. */
function xrClickScope(
  entries: readonly SearchableEntry[],
  element: Element,
  options: XrNodeClickOptions,
  {
    hierarchy,
    resolveContainer,
  }: { hierarchy: ViewHierarchyResult; resolveContainer?: XrContainerResolver },
): { scoped: boolean; containerIndex: number } {
  const scoped = options.container !== undefined;
  const container = scoped ? resolveContainer?.(hierarchy) : undefined;
  const containerEntry = container ? findTapTargetNode(entries, container) : undefined;
  const containerIndex = containerEntry ? entries.indexOf(containerEntry) : -1;
  const targetEntry = findTapTargetNode(entries, element);
  const targetIsContainerAncestor =
    containerEntry &&
    targetEntry &&
    isInsideScope(entries, containerEntry, {
      scoped: true,
      containerIndex: entries.indexOf(targetEntry),
    });
  const scope = { scoped: scoped && !targetIsContainerAncestor, containerIndex };
  if (scope.scoped && (!targetEntry || !isInsideScope(entries, targetEntry, scope))) {
    throw xrCoordinateError();
  }
  return scope;
}

/** Whether `entry` is a strict descendant of the requested container (always, when unscoped). */
function isInsideScope(
  entries: readonly SearchableEntry[],
  entry: SearchableEntry,
  scope: { scoped: boolean; containerIndex: number },
): boolean {
  if (!scope.scoped) {
    return true;
  }
  for (let at = entry.parentIndex; at !== undefined; at = entries[at].parentIndex) {
    if (at === scope.containerIndex) {
      return true;
    }
  }
  return false;
}

/**
 * The target's ancestor indexes, nearest first. A container-scoped selection may only
 * activate an owner strictly inside the container, so the walk stops there; an unresolved
 * container or one off the target's parent chain refuses.
 */
function ancestorsWithinScope(
  entries: readonly SearchableEntry[],
  target: SearchableEntry,
  scope: { scoped: boolean; containerIndex: number },
): number[] {
  const ancestors: number[] = [];
  for (let at = target.parentIndex; at !== undefined; at = entries[at].parentIndex) {
    ancestors.push(at);
  }
  if (!scope.scoped) {
    return ancestors;
  }
  const boundary = ancestors.indexOf(scope.containerIndex);
  if (boundary < 0) {
    throw xrCoordinateError();
  }
  return ancestors.slice(0, boundary);
}

function xrAncestorClickSelector(
  element: Element,
  entries: readonly SearchableEntry[],
  uniqueSelector: (candidate: Element, label?: Element) => VerifiedNodeTarget | undefined,
  scope: { scoped: boolean; containerIndex: number },
): VerifiedNodeTarget {
  // Bind the label to one captured source before following actual parent links.
  // A view-id locates a captured node; it is never sent as a native action selector.
  const targetSelector = stableNodeSelectorForElement(element);
  const targets = entries.filter(
    (entry) =>
      entry.bounds &&
      boundsNearlyEqual(entry.bounds, element.bounds, 0) &&
      entry.properties.text === element.text &&
      !hasAccessibilityAction(entry.properties.actions, "click") &&
      (element["view-id"]
        ? entry.properties["view-id"] === element["view-id"]
        : targetSelector && matchesCtrlProxyNodeSelector(entry.properties, targetSelector)),
  );
  if (new Set(targets.map((entry) => entry.source)).size !== 1) {
    throw xrCoordinateError();
  }
  for (const at of ancestorsWithinScope(entries, targets[0], scope)) {
    const ancestor = entries[at];
    const bounds = ancestor.bounds;
    if (
      !bounds ||
      bounds.left > element.bounds.left ||
      bounds.top > element.bounds.top ||
      bounds.right < element.bounds.right ||
      bounds.bottom < element.bounds.bottom ||
      !hasAccessibilityAction(ancestor.properties.actions, "click")
    ) {
      continue;
    }
    const selector = uniqueSelector(
      { ...ancestor.properties, bounds },
      { ...targets[0].properties, bounds: element.bounds },
    );
    if (selector) {
      return selector;
    }
  }
  throw xrCoordinateError();
}

export async function executeXrNodeClick<O extends XrNodeClickOptions>(
  accessibilityService: () => Pick<
    TapOnCtrlProxy,
    "supportsNodeActionSelectors" | "requestNodeAction"
  >,
  {
    action,
    element,
    signal,
    options,
    resolveContainer,
  }: {
    action: string;
    element: Element;
    signal?: AbortSignal;
    options?: O;
    resolveContainer?: (hierarchy: ViewHierarchyResult, options: O) => Element | undefined;
  },
): Promise<void> {
  throwIfAborted(signal);
  const { selector, expectedBounds, identityHints } = xrNodeClickSelector(
    action,
    element,
    options ?? {},
    options && resolveContainer && ((hierarchy) => resolveContainer(hierarchy, options)),
  );
  try {
    if (!(await accessibilityService().supportsNodeActionSelectors(undefined, signal, true))) {
      throw xrCoordinateError();
    }
    throwIfAborted(signal);
    options?.displayFence?.assertCurrent();
    const result = await accessibilityService().requestNodeAction("click", selector, {
      signal,
      expectedBounds,
      identityHints,
    });
    throwIfAborted(signal);
    if (!result.success) {
      throw xrCoordinateError();
    }
    options?.onTalkBackActivation?.();
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof StaleDisplayError) {
      throw error;
    }
    throw new ActionableError(xrCoordinateError().message, { cause: error });
  }
}
