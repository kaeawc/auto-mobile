import { getHierarchySnapshot } from "../observe/HierarchyCapture";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { ResolverSelector } from "../../server/elementSelectorSchemas";
import { ElementResolver, type ResolutionAction } from "./ElementResolver";
import { SearchableHierarchy } from "./SearchableNode";
import { extractHierarchyScreenSize } from "../observe/hierarchyScreenSize";
import type { TextSelectionIntent } from "../../utils/interfaces/ElementFinder";

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
        intentAction: options.scrollableContainer ? "scroll" : (options.intentAction ?? "tap"),
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
      { sibling: { text, ...(options.fuzzyMatch === false ? ({ match: "exact" } as const) : {}) } },
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
      { id: "container", nodes: this.projection.project(capture) },
      container,
      { action: "inspect" },
    );
    if (result.error && result.error !== "Container not found") {
      throw new ActionableError(result.error);
    }
    return result.chosen !== null;
  }

  private viewport(capture: ViewHierarchyResult) {
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
    const nodes = this.projection.project(capture);
    const result = this.resolver.resolve(
      {
        id:
          getHierarchySnapshot(capture)?.captureId ??
          capture.frameContext ??
          String(capture.updatedAt ?? "capture"),
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
          options.intentAction ?? (options.selectionIntent === "focus-input" ? "input" : "tap"),
      },
    );
    if (result.error && result.error !== "Container not found") {
      throw new ActionableError(result.error);
    }
    return {
      element: result.chosen?.element ?? null,
      indexInMatches: result.indexInMatches ?? -1,
      totalMatches: result.candidates.length,
      strategy: options.strategy ?? "first",
    };
  }
}
