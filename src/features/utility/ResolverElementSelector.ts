import { getHierarchySnapshot } from "../observe/HierarchyCapture";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { ResolverSelector } from "../../server/elementSelectorSchemas";
import {
  ElementResolver,
  matchedSourceNode,
  type ElementResolution,
  type ResolutionAction,
} from "./ElementResolver";
import { SearchableHierarchy, type SearchableEntry } from "./SearchableNode";
import { extractHierarchyScreenSize } from "../observe/hierarchyScreenSize";
import type { TextSelectionIntent } from "../../utils/interfaces/ElementFinder";
import { resolveViewHierarchyForSearch } from "../../utils/viewHierarchySearch";

interface SelectionOptions {
  container?: { elementId?: string; text?: string } | null;
  partialMatch?: boolean;
  caseSensitive?: boolean;
  fuzzyMatch?: boolean;
  strategy?: "first" | "random";
  index?: number;
  selectionIntent?: TextSelectionIntent;
  intentAction?: ResolutionAction;
  scrollableContainer?: boolean;
}

/** Compatibility at the injected selector boundary; all matching belongs to ElementResolver. */
export class ResolverElementSelector implements ElementSelector {
  constructor(
    private readonly resolver: Pick<ElementResolver, "resolve"> = new ElementResolver(),
    private readonly projection = new SearchableHierarchy(),
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

  hasContainer(
    capture: ViewHierarchyResult,
    container: { elementId?: string; text?: string },
  ): boolean {
    const result = this.resolver.resolve(
      {
        id: "container",
        nodes: this.selectionNodes(capture, {}),
      },
      container,
      { action: "inspect" },
    );
    if (result.error && result.error !== "Container not found") {
      throw new ActionableError(result.error);
    }
    return result.chosen !== null;
  }

  private viewport(capture: ViewHierarchyResult) {
    const snapshot = getHierarchySnapshot(capture);
    if (
      snapshot?.searchRaw ||
      (snapshot?.platform !== "ios" && resolveViewHierarchyForSearch(capture) !== capture)
    ) {
      return undefined;
    }
    return (
      extractHierarchyScreenSize(capture) ??
      (capture.screenWidth && capture.screenHeight
        ? { width: capture.screenWidth, height: capture.screenHeight }
        : undefined)
    );
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
        viewport: this.viewport(capture),
        action:
          options.intentAction ??
          (options.selectionIntent === "focus-input" ? "focus-input" : "tap"),
        preferTap: options.intentAction === "inspect" && options.selectionIntent === "tap",
        requireBounds: options.intentAction === "inspect",
      },
    );
    if (result.error && result.error !== "Container not found") {
      throw new ActionableError(result.error);
    }
    if (!result.error && !result.chosen && options.intentAction === "long-press") {
      return this.select(capture, selector, { ...options, intentAction: "tap" });
    }
    return this.selectionResult(
      result,
      capture,
      options.strategy ?? "first",
      options.intentAction,
      selector,
    );
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
    strategy: "first" | "random",
    action?: ResolutionAction,
    selector?: ResolverSelector,
  ): ElementSelectionResult {
    const source = matchedSourceNode(result, selector);
    return {
      element:
        action === "highlight" && result.chosen && source?.element
          ? source.element
          : (result.chosen?.element ?? null),
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
