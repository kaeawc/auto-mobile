import { ActionableError, type ElementSelectionResult } from "../../models";
import type { TapVerificationOptions } from "./tapVerificationOptions";
import { TapTargetUnavailableError } from "./tapTargetSupport";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { childrenOf, nodeAttributes } from "../../models/ViewHierarchyResult";
import {
  attachRawViewHierarchy,
  getRawViewHierarchy,
  resolveViewHierarchyForSearch,
} from "../utility/viewHierarchySearch";
import { SearchableHierarchy, matchesCtrlProxyNodeSelector } from "../utility/SearchableNode";
import { stableNodeSelectorForElement } from "../talkback/nodeActionTarget";
import { isCompleteHierarchy } from "../talkback/resourceIdActionError";
import { hasAccessibilityAction } from "../utility/elementProperties";
import { boundsNearlyEqual } from "../../utils/bounds";

/**
 * Selection-only projection: preserve visible descendants, never promote hidden XR chrome.
 * The non-enumerable raw capture (raw element search) is projected the same way and
 * re-attached, so the uncapped search universe survives without the hidden chrome.
 */
export function withoutHiddenXrChrome(hierarchy: ViewHierarchyResult): {
  hierarchy: ViewHierarchyResult;
  hiddenNodes: ReadonlySet<ViewHierarchyNode>;
} {
  return projectWithoutHiddenXrChrome(hierarchy);
}

function projectWithoutHiddenXrChrome(
  hierarchy: ViewHierarchyResult,
  nodeClickTargets: ReadonlySet<ViewHierarchyNode> = new Set(),
) {
  const hiddenNodes = new Set<ViewHierarchyNode>();
  const raw = getRawViewHierarchy(hierarchy);
  const projected = projectTree(hierarchy, hiddenNodes, nodeClickTargets);
  const projectedRaw =
    raw && raw !== hierarchy ? projectTree(raw, hiddenNodes, nodeClickTargets) : undefined;
  if (hiddenNodes.size === 0) {
    return { hierarchy, hiddenNodes };
  }
  if (projectedRaw) {
    attachRawViewHierarchy(projected, projectedRaw);
  }
  return { hierarchy: projected, hiddenNodes };
}

function projectTree(
  hierarchy: ViewHierarchyResult,
  hiddenNodes: Set<ViewHierarchyNode>,
  nodeClickTargets: ReadonlySet<ViewHierarchyNode>,
): ViewHierarchyResult {
  const hiddenBefore = hiddenNodes.size;
  const systemWindows = new Set(
    hierarchy.windows
      ?.filter((window) => window.packageName?.startsWith("com.android.systemui"))
      .map((window) => window.id),
  );
  function filter(node: ViewHierarchyNode, systemWindow = false): ViewHierarchyNode[] {
    // Captures can carry an array root as well as XML-shaped single children.
    if (Array.isArray(node)) {
      return node.flatMap((child: ViewHierarchyNode) => filter(child, systemWindow));
    }
    const attrs = nodeAttributes(node);
    const owner =
      systemWindow || (typeof attrs.windowId === "number" && systemWindows.has(attrs.windowId));
    const children = childrenOf(node).flatMap((child) => filter(child, owner));
    if (
      attrs["visible-to-user"] === false &&
      !nodeClickTargets.has(node) &&
      (owner ||
        (typeof attrs["resource-id"] === "string" &&
          attrs["resource-id"].startsWith("com.android.systemui")))
    ) {
      hiddenNodes.add(node);
      return children;
    }
    const originalChildren = childrenOf(node);
    return [
      children.length === originalChildren.length &&
      children.every((child, index) => child === originalChildren[index])
        ? node
        : { ...node, node: children },
    ];
  }
  const roots = hierarchy.hierarchy.node ? filter(hierarchy.hierarchy.node) : [];
  const windows = hierarchy.windows?.map((window) => ({
    ...window,
    hierarchy: window.hierarchy
      ? { node: filter(window.hierarchy, window.packageName?.startsWith("com.android.systemui")) }
      : undefined,
  }));
  if (hiddenNodes.size === hiddenBefore) {
    // Nothing hidden here: copy the shell so a carrier can attach without mutating input.
    return { ...hierarchy };
  }
  return {
    ...hierarchy,
    hierarchy: { ...hierarchy.hierarchy, node: { node: roots } },
    windows,
  };
}

interface ChromeSelection {
  selection: ElementSelectionResult;
  containerFound: boolean;
  visibilityError?: TapTargetUnavailableError;
}
type Select = (options: TapVerificationOptions, hierarchy: ViewHierarchyResult) => ChromeSelection;

/** Mirror the stable-selector branch of xrPanelNodeClick; hidden nodes never use bounds alone. */
function hiddenNodeClickTargets(hierarchy: ViewHierarchyResult): ReadonlySet<ViewHierarchyNode> {
  const capture = resolveViewHierarchyForSearch(hierarchy) ?? null;
  if (!isCompleteHierarchy(capture)) {
    return new Set();
  }
  const entries = new SearchableHierarchy().project(capture);
  return new Set(
    entries
      .filter((entry) => {
        if (
          entry.properties["visible-to-user"] !== false ||
          !entry.bounds ||
          entry.properties["hierarchy-source"] === "uiautomator" ||
          !hasAccessibilityAction(entry.properties.actions, "click")
        ) {
          return false;
        }
        const selector = stableNodeSelectorForElement(entry.properties);
        if (!selector) {
          return false;
        }
        const matches = entries.filter((candidate) =>
          matchesCtrlProxyNodeSelector(candidate.properties, selector),
        );
        return (
          new Set(matches.map((candidate) => candidate.source)).size === 1 &&
          !!matches[0]?.bounds &&
          boundsNearlyEqual(matches[0].bounds, entry.bounds, 0)
        );
      })
      .map((entry) => entry.source),
  );
}

function hiddenChromeFailure(
  options: TapVerificationOptions,
  original: ChromeSelection,
  hiddenNodes: ReadonlySet<ViewHierarchyNode>,
): TapTargetUnavailableError | undefined {
  const match = original.selection.matchedElement ?? original.selection.element;
  const source = match && getHierarchyNodeSource(match);
  if (!source || !hiddenNodes.has(source)) {
    return undefined;
  }
  const label =
    options.text ?? options.textAny?.join(" | ") ?? options.elementId ?? options.testTag;
  return new TapTargetUnavailableError(
    `Target '${label}' is hidden XR system chrome (visible-to-user false, systemui). ` +
      "Use observe to find the visible control or tapAt with screen coordinates from the screenshot.",
    "no-visible-tap-area",
  );
}

function withHiddenChromeFailure(
  result: ChromeSelection,
  hiddenFailure: () => TapTargetUnavailableError | undefined,
): ChromeSelection {
  const match = result.selection.matchedElement ?? result.selection.element;
  // Do not turn a refused exact hidden match ("Launcher") into a different
  // hidden substring match ("Open Launcher Panel"). Visible matches still win.
  const refused = match?.["visible-to-user"] === false ? hiddenFailure() : undefined;
  if (refused) {
    return {
      ...result,
      selection: { ...result.selection, element: null, matchedElement: undefined },
      visibilityError: refused,
    };
  }
  return result.selection.element || result.selection.matchedElement
    ? result
    : { ...result, visibilityError: hiddenFailure() };
}

/** Pure selection with the caller's synchronous selector; observations remain unmodified. */
export function selectWithoutHiddenXrChrome(
  options: TapVerificationOptions,
  hierarchy: ViewHierarchyResult,
  select: Select,
): ChromeSelection {
  const filtered = projectWithoutHiddenXrChrome(
    hierarchy,
    options.action === "tap" ? hiddenNodeClickTargets(hierarchy) : undefined,
  );
  if (filtered.hiddenNodes.size === 0) {
    return select(options, hierarchy);
  }
  const inspectOptions = { ...options, selectionStrategy: "first" as const, index: undefined };
  const hiddenFailure = () =>
    hiddenChromeFailure(options, select(inspectOptions, hierarchy), filtered.hiddenNodes);
  try {
    return withHiddenChromeFailure(select(options, filtered.hierarchy), hiddenFailure);
  } catch (error) {
    if (!(error instanceof ActionableError)) {
      throw error;
    }
    const inspected = select(inspectOptions, filtered.hierarchy);
    if (inspected.selection.element || inspected.selection.matchedElement) {
      throw error;
    }
    const visibilityError = hiddenFailure();
    if (!visibilityError) {
      throw error;
    }
    return {
      selection: {
        element: null,
        indexInMatches: -1,
        totalMatches: 0,
        strategy: options.selectionStrategy ?? "first",
      },
      containerFound: true,
      visibilityError,
    };
  }
}
