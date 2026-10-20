import { isStrictlyScoped, propagateUniqueStrategy } from "./ScopedSelection";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import { getHierarchySnapshot } from "../observe/HierarchyCapture";
import type {
  ElementSelectionOptions,
  ElementSelector,
} from "../../utils/interfaces/ElementSelector";
import type { ElementQuery } from "../../models/ElementQuery";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { Element, ViewHierarchyResult } from "../../models";
import { nodeAttributes } from "../../models/ViewHierarchyResult";
import { ActionableError, type ContainerFailure } from "../../models/ActionableError";
import type { ResolverSelector } from "../../models/elementSelectorSchemas";
import {
  ElementResolver,
  isMissingContainerError,
  matchedSourceNode,
  type ElementResolution,
  type ResolutionIntent,
  type ResolverSnapshot,
} from "./ElementResolver";
import { SearchableHierarchy, isImeKeyEntry, type SearchableEntry } from "./SearchableNode";
import {
  screenSizeForOffscreenCheck,
  type ScreenSizeForOffscreenCheckOptions,
} from "./ElementGeometry";
import { resolveViewHierarchyForSearch } from "./viewHierarchySearch";

/** A text selector, the kind a client copies from an observed label. */
function selectsByText(selector: ResolverSelector): boolean {
  return selector.text !== undefined || selector.sibling?.text !== undefined;
}

type SelectionOptions = ElementSelectionOptions;

function resolutionIntent(
  selector: ResolverSelector,
  options: SelectionOptions,
  viewport: ResolutionIntent["viewport"],
): ResolutionIntent {
  return {
    viewport,
    action:
      options.intentAction ?? (options.selectionIntent === "focus-input" ? "focus-input" : "tap"),
    allowHintFallback: options.allowHintFallback,
    preferToggle: options.selectionIntent === "toggle",
    preferTap:
      options.intentAction === "inspect" &&
      (options.selectionIntent === "tap" || options.selectionIntent === "toggle"),
    requireBounds: options.intentAction === "inspect",
    // The client picked this label from `observe`, which folds the keyboard into one row.
    excludeImeKeys: selectsByText(selector),
  };
}

function withMatchPolicy(query: ElementQuery, options: SelectionOptions): ResolverSelector {
  if (query.match !== undefined) {
    return query;
  }
  const sibling = query.sibling;
  if (sibling) {
    const contains =
      sibling.text !== undefined ? options.fuzzyMatch === true : options.partialMatch === true;
    return {
      ...query,
      sibling: sibling.match || !contains ? sibling : { ...sibling, match: "contains" },
    };
  }
  if (query.text !== undefined) {
    return options.partialMatch === false ? { ...query, match: "exact" } : query;
  }
  return query.elementId !== undefined && options.partialMatch === true
    ? { ...query, match: "contains" }
    : query;
}

/** A resolved container plus the capture's visibility flag for its node. */
export interface ContainerMatch {
  element?: Element;
  /** The node's captured `visible-to-user` flag; absent when the capture carries none. */
  visibleToUser?: boolean;
}

/** Compatibility at the injected selector boundary; all matching belongs to ElementResolver. */
export class ResolverElementSelector implements ElementSelector {
  constructor(
    private readonly resolver: Pick<ElementResolver, "resolve"> = new ElementResolver(),
    private readonly projection = new SearchableHierarchy(),
    private readonly options: ScreenSizeForOffscreenCheckOptions = {},
  ) {}

  /** @deprecated Use `select` with `{ text }`. */
  selectByText(
    capture: ViewHierarchyResult,
    text: string,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(capture, { text }, options);
  }

  /** @deprecated Use `select` with `{ elementId }`. */
  selectByResourceId(
    capture: ViewHierarchyResult,
    elementId: string,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(capture, { elementId }, options);
  }

  /** @deprecated Use `select` with `{ testTag }`. */
  selectByTestTag(
    capture: ViewHierarchyResult,
    testTag: string,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(capture, { testTag }, options);
  }

  /** @deprecated Use `select` with `{}` and a tap intent. */
  selectClickable(
    capture: ViewHierarchyResult,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(capture, {}, { ...options, intentAction: options.intentAction ?? "tap" });
  }

  /** @deprecated Use `select` with `{ sibling: { text } }`. */
  selectClickableSiblingOfText(
    capture: ViewHierarchyResult,
    text: string,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(capture, { sibling: { text } }, options);
  }

  /** @deprecated Use `select` with `{ sibling: { elementId } }`. */
  selectClickableSiblingOfResourceId(
    capture: ViewHierarchyResult,
    elementId: string,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(capture, { sibling: { elementId } }, options);
  }

  hasContainer(capture: ViewHierarchyResult, container: ElementContainerSelector): boolean {
    return this.containerResolution(capture, container).scope !== undefined;
  }

  resolveContainer(
    capture: ViewHierarchyResult,
    container: ElementContainerSelector,
    strategy?: ElementSelectionStrategy,
  ) {
    return this.resolveContainerMatch(capture, container, strategy)?.element;
  }

  /** Like `resolveContainer`, but also reports whether the capture marks the node visible. */
  resolveContainerMatch(
    capture: ViewHierarchyResult,
    container: ElementContainerSelector,
    strategy?: ElementSelectionStrategy,
  ): ContainerMatch | undefined {
    const scope = this.containerResolution(capture, container, strategy).scope;
    if (!scope) {
      return undefined;
    }
    const visibleToUser = nodeAttributes(scope.source)["visible-to-user"];
    return {
      element: scope.element,
      ...(typeof visibleToUser === "boolean" ? { visibleToUser } : {}),
    };
  }

  private containerResolution(
    capture: ViewHierarchyResult,
    container: ElementContainerSelector,
    strategy?: ElementSelectionStrategy,
  ) {
    const result: ElementResolution & { containerFailure?: ContainerFailure } =
      this.resolver.resolve(
        { id: "container", nodes: this.selectionNodes(capture, {}) },
        {
          container: propagateUniqueStrategy(container, strategy),
        },
        { action: "inspect" },
      );
    if (result.error && !isMissingContainerError(result.error)) {
      throw new ActionableError(result.error, {
        containerFailure: result.containerFailure,
      });
    }
    return result;
  }

  private viewport(capture: ViewHierarchyResult, options: ScreenSizeForOffscreenCheckOptions = {}) {
    const snapshot = getHierarchySnapshot(capture);
    if (
      snapshot?.searchRaw ||
      (snapshot?.platform !== "ios" && resolveViewHierarchyForSearch(capture) !== capture)
    ) {
      return undefined;
    }
    return screenSizeForOffscreenCheck(capture, { ...this.options, ...options });
  }

  /**
   * The one entry point: resolve `query` against the capture with the caller's named intent. A
   * query without an explicit `match` takes it from the options' match policy: `partialMatch`
   * false makes a text query exact, true makes an element ID (or sibling ID) contain-match, and
   * `fuzzyMatch` makes a sibling text contain-match; otherwise the resolver's default applies.
   */
  select(
    capture: ViewHierarchyResult,
    query: ElementQuery,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    const selector = withMatchPolicy(query, options);
    const snapshot = { id: this.snapshotId(capture), nodes: this.selectionNodes(capture, options) };
    const resolverSelector: ResolverSelector = {
      ...selector,
      index: options.index,
      selectionStrategy: options.strategy,
      caseSensitive: options.caseSensitive,
      container: options.container ?? undefined,
    };
    const intent = resolutionIntent(
      selector,
      options,
      this.viewport(capture, options.screenSizeOptions),
    );
    const result = this.resolver.resolve(snapshot, resolverSelector, intent);
    this.checkResolutionError(result, options);
    if (!result.error && !result.chosen && options.intentAction === "long-press") {
      return this.select(capture, query, { ...options, intentAction: "tap" });
    }
    const selection = this.selectionResult(result, capture, options.strategy ?? "first", selector);
    return intent.excludeImeKeys && !result.error && !result.chosen
      ? this.flagKeyboardOnlyMatch(selection, snapshot, resolverSelector, intent)
      : selection;
  }

  /** Mark a miss whose only match is a keyboard key, so the caller can say so (issue #10225). */
  private flagKeyboardOnlyMatch(
    selection: ElementSelectionResult,
    snapshot: ResolverSnapshot,
    selector: ResolverSelector,
    intent: ResolutionIntent,
  ): ElementSelectionResult {
    const withKeys = this.resolver.resolve(snapshot, selector, {
      ...intent,
      excludeImeKeys: false,
    });
    // An out-of-range `index` would also pick a key once the keys are counted; only a
    // key the selector would have tapped makes the keyboard the reason for the miss.
    return withKeys.chosen && isImeKeyEntry(withKeys.chosen)
      ? { ...selection, onlyKeyboardKeyMatch: true }
      : selection;
  }

  // Accept the additive field from dependency PR #10292 before its resolver lands here.
  private checkResolutionError(
    resolution: ElementResolution & { containerFailure?: ContainerFailure },
    options: SelectionOptions,
  ): void {
    const { error, containerFailure } = resolution;
    if (!error) {
      return;
    }
    const strictScope = isStrictlyScoped(
      { container: options.container, selectionStrategy: options.strategy },
      "nested-container-defined",
    );
    if (strictScope || !isMissingContainerError(error)) {
      throw new ActionableError(error, { containerFailure });
    }
  }

  private snapshotId(capture: ViewHierarchyResult): string {
    return (
      getHierarchySnapshot(capture)?.captureId ??
      capture.frameContext ??
      String(capture.updatedAt ?? "capture")
    );
  }

  private selectionNodes(
    capture: ViewHierarchyResult,
    options: SelectionOptions,
  ): readonly SearchableEntry[] {
    const snapshot = getHierarchySnapshot(capture);
    const raw = snapshot?.platform === "ios" ? capture : resolveViewHierarchyForSearch(capture);
    const nodes =
      raw && raw !== capture
        ? this.projection.project(raw)
        : (snapshot?.nodes ?? this.projection.project(capture));
    if (!options.scrollableContainer) {
      return nodes;
    }
    const scope = options.container
      ? this.resolver.resolve({ id: "scroll-scope", nodes }, options.container, {
          action: "inspect",
        }).chosen
      : undefined;
    const withinScrollingRoot = (node: SearchableEntry) => {
      let ancestor: SearchableEntry | undefined = node;
      while (ancestor) {
        if (ancestor.affordances.includes("scroll")) {
          return true;
        }
        if (ancestor === scope) {
          break;
        }
        ancestor = ancestor.parentIndex === undefined ? undefined : nodes[ancestor.parentIndex];
      }
      return false;
    };
    // Preserve indices/ancestry for the resolver while excluding out-of-scope actions.
    return nodes.map((node) => (withinScrollingRoot(node) ? node : { ...node, affordances: [] }));
  }

  private selectionResult(
    result: ElementResolution,
    capture: ViewHierarchyResult,
    strategy: ElementSelectionStrategy,
    selector?: ResolverSelector,
  ): ElementSelectionResult {
    const source = matchedSourceNode(result, selector);
    return {
      element: result.chosen?.element ?? null,
      ...(source?.element ? { matchedElement: source.element } : {}),
      ...(getHierarchySnapshot(capture)
        ? { captureId: getHierarchySnapshot(capture)!.captureId }
        : {}),
      indexInMatches: result.indexInMatches ?? -1,
      totalMatches: result.candidates.length,
      strategy,
    };
  }
}
