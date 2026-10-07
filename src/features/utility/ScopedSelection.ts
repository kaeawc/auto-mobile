import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";

/** Top-level unique overrides the strategy of the next container level. */
export function propagateUniqueStrategy(
  container: ElementContainerSelector,
  strategy?: ElementSelectionStrategy,
): ElementContainerSelector {
  return strategy === "unique" ? { ...container, selectionStrategy: "unique" } : container;
}

interface ScopedSelection {
  container?: ElementContainerSelector | null;
  selectionStrategy?: ElementSelectionStrategy;
  index?: number;
}

export type StrictScopePolicy =
  | "nested-container"
  | "nested-container-defined"
  | "any-container"
  | "swipe-container-options"
  | "swipe-look-for-options";

const scopePolicies: Record<StrictScopePolicy, (selector: ScopedSelection) => boolean> = {
  // TapOn, TapAny dispatch and DragAndDrop preflight use nested scopes.
  "nested-container": (selector) =>
    selector.selectionStrategy === "unique" || !!selector.container?.container,
  // ResolverElementSelector historically checks presence rather than truthiness.
  "nested-container-defined": (selector) =>
    selector.selectionStrategy === "unique" || selector.container?.container !== undefined,
  // TapAny retry and DragAndDrop diagnostics count even a plain one-level container.
  "any-container": (selector) => !!selector.container || selector.selectionStrategy === "unique",
  // Swipe's documented container index/strategy opt-in applies to the container itself.
  "swipe-container-options": (selector) =>
    selector.container !== undefined ||
    selector.selectionStrategy !== undefined ||
    selector.index !== undefined,
  // Swipe lookFor opts in on any strategy or container, but ignores index.
  "swipe-look-for-options": (selector) =>
    selector.container !== undefined || selector.selectionStrategy !== undefined,
};

/** Preserve the tools' existing opt-ins; these policies do not change resolution itself. */
export function isStrictlyScoped(
  selector: ScopedSelection | undefined,
  policy: StrictScopePolicy = "nested-container",
): boolean {
  return !!selector && scopePolicies[policy](selector);
}
