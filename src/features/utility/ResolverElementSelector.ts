import { isStrictlyScoped, propagateUniqueStrategy } from "./ScopedSelection";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import { getHierarchySnapshot } from "../observe/HierarchyCapture";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { ResolverSelector } from "../../server/elementSelectorSchemas";
import {
  ElementResolver,
  isMissingContainerError,
  matchedSourceNode,
  type ElementResolution,
  type ResolutionAction,
} from "./ElementResolver";
import { SearchableHierarchy, type SearchableEntry } from "./SearchableNode";
import {
  screenSizeForOffscreenCheck,
  type ScreenSizeForOffscreenCheckOptions,
} from "./ElementGeometry";
import type { TextSelectionIntent } from "../../utils/interfaces/ElementFinder";
import { resolveViewHierarchyForSearch } from "./viewHierarchySearch";

interface SelectionOptions {
  container?: ElementContainerSelector | null;
  partialMatch?: boolean;
  caseSensitive?: boolean;
  fuzzyMatch?: boolean;
  strategy?: ElementSelectionStrategy;
  index?: number;
  selectionIntent?: TextSelectionIntent;
  allowHintFallback?: boolean;
  intentAction?: ResolutionAction;
  scrollableContainer?: boolean;
  screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
}

/** Compatibility at the injected selector boundary; all matching belongs to ElementResolver. */
export class ResolverElementSelector implements ElementSelector {
  constructor(
    private readonly resolver: Pick<ElementResolver, "resolve"> = new ElementResolver(),
    private readonly projection = new SearchableHierarchy(),
    private readonly options: ScreenSizeForOffscreenCheckOptions = {},
  ) {}

  selectByText(
    capture: ViewHierarchyResult,
    text: string,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(
      capture,
      { text, ...(options.partialMatch === false ? ({ match: "exact" } as const) : {}) },
      options,
    );
  }

  selectByResourceId(
    capture: ViewHierarchyResult,
    elementId: string,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(
      capture,
      { elementId, ...(options.partialMatch === true ? ({ match: "contains" } as const) : {}) },
      options,
    );
  }

  selectByTestTag(
    capture: ViewHierarchyResult,
    testTag: string,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(capture, { testTag }, options);
  }

  selectClickable(
    capture: ViewHierarchyResult,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(
      capture,
      {},
      {
        ...options,
        intentAction: options.intentAction ?? "tap",
      },
    );
  }

  selectClickableSiblingOfText(
    capture: ViewHierarchyResult,
    text: string,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(
      capture,
      {
        sibling: { text, ...(options.fuzzyMatch === true ? ({ match: "contains" } as const) : {}) },
      },
      options,
    );
  }

  selectClickableSiblingOfResourceId(
    capture: ViewHierarchyResult,
    elementId: string,
    options: SelectionOptions = {},
  ): ElementSelectionResult {
    return this.select(
      capture,
      {
        sibling: {
          elementId,
          ...(options.partialMatch === true ? ({ match: "contains" } as const) : {}),
        },
      },
      options,
    );
  }

  hasContainer(capture: ViewHierarchyResult, container: ElementContainerSelector): boolean {
    return this.containerResolution(capture, container).scope !== undefined;
  }

  resolveContainer(
    capture: ViewHierarchyResult,
    container: ElementContainerSelector,
    strategy?: ElementSelectionStrategy,
  ) {
    return this.containerResolution(capture, container, strategy).scope?.element;
  }

  private containerResolution(
    capture: ViewHierarchyResult,
    container: ElementContainerSelector,
    strategy?: ElementSelectionStrategy,
  ) {
    const result = this.resolver.resolve(
      { id: "container", nodes: this.selectionNodes(capture, {}) },
      {
        container: propagateUniqueStrategy(container, strategy),
      },
      { action: "inspect" },
    );
    if (result.error && !isMissingContainerError(result.error)) {
      throw new ActionableError(result.error);
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

  private select(
    capture: ViewHierarchyResult,
    selector: ResolverSelector,
    options: SelectionOptions,
  ): ElementSelectionResult {
    const nodes = this.selectionNodes(capture, options);
    const result = this.resolver.resolve(
      {
        id: this.snapshotId(capture),
        nodes,
      },
      {
        ...selector,
        index: options.index,
        selectionStrategy: options.strategy,
        caseSensitive: options.caseSensitive,
        container: options.container ?? undefined,
      },
      {
        viewport: this.viewport(capture, options.screenSizeOptions),
        action:
          options.intentAction ??
          (options.selectionIntent === "focus-input" ? "focus-input" : "tap"),
        allowHintFallback: options.allowHintFallback,
        preferToggle: options.selectionIntent === "toggle",
        preferTap:
          options.intentAction === "inspect" &&
          (options.selectionIntent === "tap" || options.selectionIntent === "toggle"),
        requireBounds: options.intentAction === "inspect",
      },
    );
    this.checkResolutionError(result.error, options);
    if (!result.error && !result.chosen && options.intentAction === "long-press") {
      return this.select(capture, selector, { ...options, intentAction: "tap" });
    }
    return this.selectionResult(result, capture, options.strategy ?? "first", selector);
  }

  private checkResolutionError(error: string | undefined, options: SelectionOptions): void {
    if (!error) {
      return;
    }
    const strictScope = isStrictlyScoped(
      { container: options.container, selectionStrategy: options.strategy },
      "nested-container-defined",
    );
    if (strictScope || !isMissingContainerError(error)) {
      throw new ActionableError(error);
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
