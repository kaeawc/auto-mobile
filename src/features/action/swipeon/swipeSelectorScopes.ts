import { isStrictlyScoped } from "../../utility/ScopedSelection";
import { ActionableError } from "../../../models/ActionableError";
import {
  isMissingContainerError,
  matchedSourceNode,
  type ElementResolver,
} from "../../utility/ElementResolver";
import type { SearchableEntry } from "../../utility/SearchableNode";
import type { Element } from "../../../models/Element";
import type { ElementContainerSelector } from "../../../models/PinchOnOptions";
import type { SwipeOnOptions } from "../../../models/SwipeOnOptions";

/** lookFor's chain is more specific than the independently resolved swipe container. */
export function appendSwipeScope(
  scope: ElementContainerSelector | undefined,
  swipeContainer: ElementContainerSelector | undefined,
): ElementContainerSelector | undefined {
  if (!scope) {
    return swipeContainer;
  }
  return { ...scope, container: appendSwipeScope(scope.container, swipeContainer) };
}

export function scopedSearchDescription(options: SwipeOnOptions): string {
  if (!usesScopedSwipeContainer(options.container) && !usesScopedSwipeLookFor(options.lookFor)) {
    return "";
  }
  const levels: string[] = [];
  for (
    let scope = appendSwipeScope(options.lookFor?.container, options.container);
    scope;
    scope = scope.container
  ) {
    levels.unshift(JSON.stringify(scope.elementId ?? scope.text));
  }
  return levels.length ? ` within container scope ${levels.join(" > ")}` : "";
}

export function requiresUniqueScope(selector: NonNullable<SwipeOnOptions["lookFor"]>): boolean {
  if (selector.selectionStrategy === "unique") {
    return true;
  }
  for (let scope = selector.container; scope; scope = scope.container) {
    if (scope.selectionStrategy === "unique") {
      return true;
    }
  }
  return false;
}

/** A frame-local reference for the shared resolver, without re-drawing a random scope. */
export function bindSwipeScope(nodes: readonly SearchableEntry[], element: Element | undefined) {
  const selected = element ? nodes.find((node) => node.element === element) : undefined;
  if (!selected) {
    return { nodes, container: undefined };
  }
  let key = "swipe-resolved-scope";
  while (nodes.some((node) => node.nativeId === key || node.nodeKey === key)) {
    key += "_";
  }
  return {
    nodes: nodes.map((node) => (node === selected ? { ...node, nodeKey: key } : node)),
    container: { elementId: key },
  };
}

export function usesScopedSwipeContainer(container: SwipeOnOptions["container"]): boolean {
  return isStrictlyScoped(container, "swipe-container-options");
}

export function usesScopedSwipeLookFor(lookFor: SwipeOnOptions["lookFor"]): boolean {
  return isStrictlyScoped(lookFor, "swipe-look-for-options");
}

export function resolveSwipeLookFor({
  lookFor,
  container,
  containerElement,
  resolver,
  nodes,
  id,
}: {
  lookFor: NonNullable<SwipeOnOptions["lookFor"]>;
  container: SwipeOnOptions["container"];
  containerElement: Element | undefined;
  resolver: Pick<ElementResolver, "resolve">;
  nodes: readonly SearchableEntry[];
  id: string;
}): Element | null {
  if (!lookFor.text && !lookFor.elementId) {
    return null;
  }
  // The full swipe chain was resolved for this frame. Pin a random scope to
  // that exact node; unique scopes retain the chain to validate every level.
  const bound = bindSwipeScope(
    nodes,
    container && !requiresUniqueScope(lookFor) ? containerElement : undefined,
  );
  const selector = {
    ...lookFor,
    container: appendSwipeScope(lookFor.container, bound.container ?? container),
  };
  const result = resolver.resolve({ id, nodes: bound.nodes }, selector, { action: "inspect" });
  if (isMissingContainerError(result.error) || result.error?.startsWith("Target not found")) {
    return null;
  }
  if (result.error) {
    throw new ActionableError(result.error);
  }
  return matchedSourceNode(result, selector)?.element ?? null;
}
