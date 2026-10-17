import { TapTargetUnavailableError } from "./tapTargetSupport";
import type { TapVerificationOptions } from "./tapVerificationOptions";
import type { TapPointPlanner } from "./tapPointPlanner";
import { requireTestTag } from "./tapFocusIdentity";
import { isContainerAvailable } from "./tapSharedHelpers";
import { isStrictlyScoped, propagateUniqueStrategy } from "../utility/ScopedSelection";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import { isFocusEditableElement } from "../utility/ElementResolver";
import {
  ActionableError,
  BootedDevice,
  Element,
  ElementSelectionResult,
  ViewHierarchyResult,
} from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { TextSelectionIntent } from "../../utils/interfaces/TextSelectionIntent";
import { logger } from "../../utils/logger";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";

const TEXT_SELECTION_INTENT_BY_ACTION: Record<TapOnElementOptions["action"], TextSelectionIntent> =
  {
    tap: "tap",
    doubleTap: "tap",
    longPress: "tap",
    focus: "focus-input",
  };

/** What element lookup needs from the owning tap action (read lazily; tests swap the selector). */
export interface TapElementFinderDeps {
  readonly device: BootedDevice;
  readonly elementSelector: () => ElementSelector;
  readonly tapPoints: TapPointPlanner;
}

/** Resolves a tap selector to an element in a captured hierarchy. Never reads the device. */
export class TapElementFinder {
  constructor(private readonly deps: TapElementFinderDeps) {}

  selectVariantOrSiblingOrMiss(
    options: TapVerificationOptions,
    select: () => ElementSelectionResult,
  ): ElementSelectionResult {
    try {
      return select();
    } catch (error) {
      if (!(error instanceof ActionableError)) {
        throw error;
      }
      const expectedMissing =
        (options.verification !== undefined && error.message === "Sibling row not found") ||
        (options.textAny !== undefined &&
          options.selectionStrategy === "unique" &&
          error.message.startsWith("Target not found"));
      if (!expectedMissing) {
        throw error;
      }
      // Missing ordered text variants and polling display siblings are expected;
      // keep all lookups scoped and propagate container errors and ambiguity.
      logger.debug("[TapOnElement] Text variant or display sibling not found yet", error);
      return {
        element: null,
        totalMatches: 0,
        indexInMatches: -1,
        strategy: options.selectionStrategy ?? "first",
      };
    }
  }

  classifyFocusSelectionFailure(
    options: TapVerificationOptions,
    viewHierarchy: ViewHierarchyResult,
    error: ActionableError,
  ): never {
    // Strict selection may throw before handleElementNotFound. Inspect the same
    // hierarchy with first-match selection to distinguish absence from ambiguity
    // using selection evidence, while preserving the original diagnostic.
    const inspected = this.selectElementInHierarchy(
      { ...options, selectionStrategy: "first", index: undefined },
      viewHierarchy,
    ).selection;
    if (inspected.totalMatches === 0 && !inspected.matchedElement) {
      throw new TapTargetUnavailableError(error.message, "not-found");
    }
    const target = inspected.element ?? inspected.matchedElement;
    if (
      inspected.totalMatches === 1 &&
      target &&
      isFocusEditableElement(target) &&
      this.deps.tapPoints.isElementTapTargetOffScreen(
        inspected,
        viewHierarchy,
        this.deps.tapPoints.getScreenSizeFromHierarchy(viewHierarchy, options.screenSizeOptions),
        options,
      )
    ) {
      throw new TapTargetUnavailableError(
        error.message,
        this.deps.tapPoints.isCoveredByNavigationBar(
          inspected,
          viewHierarchy,
          this.deps.tapPoints.getScreenSizeFromHierarchy(viewHierarchy, options.screenSizeOptions),
        )
          ? "navigation-bar"
          : "no-visible-tap-area",
      );
    }
    throw error;
  }

  selectElementInHierarchy(
    options: TapVerificationOptions,
    viewHierarchy: ViewHierarchyResult,
  ): { selection: ElementSelectionResult; containerFound: boolean } {
    const containerFound = this.isContainerAvailable(viewHierarchy, options.container);
    const intentAction =
      options.action === "longPress"
        ? "long-press"
        : options.action === "focus"
          ? "focus-input"
          : "tap";
    const lookupAction = options.subtext
      ? "inspect"
      : isStrictlyScoped(options)
        ? intentAction
        : options.action === "focus"
          ? "focus-input"
          : "inspect";
    const selectionIntent = this.selectionIntentFor(options);

    const text = options.text;
    if (text) {
      if (options.sibling) {
        return {
          selection: this.selectVariantOrSiblingOrMiss(options, () =>
            this.deps.elementSelector().selectClickableSiblingOfText(viewHierarchy, text, {
              container: options.container,
              screenSizeOptions: options.screenSizeOptions,
              fuzzyMatch: true,
              caseSensitive: false,
              strategy: options.selectionStrategy,
              intentAction,
              selectionIntent,
              index: options.index,
            }),
          ),
          containerFound,
        };
      }

      return {
        selection: this.deps.elementSelector().selectByText(viewHierarchy, text, {
          container: options.container,
          screenSizeOptions: options.screenSizeOptions,
          partialMatch: true,
          caseSensitive: false,
          strategy: options.selectionStrategy,
          intentAction: lookupAction,
          allowHintFallback: options.action === "tap" || options.action === "focus",
          index: options.index,
          selectionIntent,
        }),
        containerFound,
      };
    }

    if (options.textAny) {
      let lastSelection: ElementSelectionResult | null = null;
      let offScreenSelection: ElementSelectionResult | null = null;
      const screenSize = this.deps.tapPoints.getScreenSizeFromHierarchy(
        viewHierarchy,
        options.screenSizeOptions,
      );
      for (const text of options.textAny) {
        const selection = options.sibling
          ? this.selectVariantOrSiblingOrMiss(options, () =>
              this.deps.elementSelector().selectClickableSiblingOfText(viewHierarchy, text, {
                container: options.container,
                screenSizeOptions: options.screenSizeOptions,
                fuzzyMatch: true,
                caseSensitive: false,
                strategy: options.selectionStrategy,
                intentAction,
                selectionIntent,
                index: options.index,
              }),
            )
          : this.selectVariantOrSiblingOrMiss(options, () =>
              this.deps.elementSelector().selectByText(viewHierarchy, text, {
                container: options.container,
                screenSizeOptions: options.screenSizeOptions,
                partialMatch: true,
                caseSensitive: false,
                strategy: options.selectionStrategy,
                intentAction: lookupAction,
                allowHintFallback: options.action === "tap" || options.action === "focus",
                index: options.index,
                selectionIntent,
              }),
            );
        lastSelection = selection;
        if (selection.element) {
          if (
            this.deps.tapPoints.isElementTapTargetOffScreen(
              selection,
              viewHierarchy,
              screenSize,
              options,
            )
          ) {
            offScreenSelection = selection;
            continue;
          }
          return { selection, containerFound };
        }
      }

      if (offScreenSelection) {
        return {
          selection: { ...offScreenSelection, element: null },
          containerFound,
        };
      }

      if (lastSelection) {
        if (options.selectionStrategy === "unique") {
          throw new TapTargetUnavailableError(
            `Target not found${options.container ? " within container" : ""}: no textAny variant matched`,
            "not-found",
          );
        }
        return { selection: lastSelection, containerFound };
      }
    }

    const elementId = options.elementId;
    if (elementId) {
      if (options.sibling) {
        return {
          selection: this.selectVariantOrSiblingOrMiss(options, () =>
            this.deps
              .elementSelector()
              .selectClickableSiblingOfResourceId(viewHierarchy, elementId, {
                container: options.container,
                screenSizeOptions: options.screenSizeOptions,
                partialMatch: false,
                strategy: options.selectionStrategy,
                intentAction,
                index: options.index,
              }),
          ),
          containerFound,
        };
      }

      return {
        selection: this.deps.elementSelector().selectByResourceId(viewHierarchy, elementId, {
          container: options.container,
          screenSizeOptions: options.screenSizeOptions,
          partialMatch: false,
          strategy: options.selectionStrategy,
          intentAction: lookupAction,
          index: options.index,
        }),
        containerFound,
      };
    }

    return {
      selection: this.deps
        .elementSelector()
        .selectByTestTag(viewHierarchy, requireTestTag(options), {
          container: options.container,
          screenSizeOptions: options.screenSizeOptions,
          strategy: options.selectionStrategy,
          intentAction: lookupAction,
          selectionIntent,
          index: options.index,
        }),
      containerFound,
    };
  }

  selectionIntentFor(options: TapOnElementOptions): TextSelectionIntent {
    return options.ensureChecked !== undefined && options.index === undefined && !options.elementId
      ? "toggle"
      : TEXT_SELECTION_INTENT_BY_ACTION[options.action];
  }

  isContainerAvailable(
    viewHierarchy: ViewHierarchyResult,
    container?: ElementContainerSelector,
  ): boolean {
    return isContainerAvailable(this.deps.elementSelector(), viewHierarchy, container);
  }

  resolveContainerElement(
    viewHierarchy: ViewHierarchyResult,
    options: TapVerificationOptions,
  ): Element | undefined {
    const container = options.container;
    if (!container) {
      return undefined;
    }
    const selector = this.deps.elementSelector();
    if (selector.resolveContainer) {
      return selector.resolveContainer(viewHierarchy, container, options.selectionStrategy);
    }
    const scopedOptions = {
      container: container.container,
      index: container.index,
      strategy: propagateUniqueStrategy(container, options.selectionStrategy).selectionStrategy,
    };
    if (container.elementId) {
      return this.deps.elementSelector().selectByResourceId(viewHierarchy, container.elementId, {
        ...scopedOptions,
        intentAction: "inspect",
        screenSizeOptions: options.screenSizeOptions,
      }).element as Element | undefined;
    }
    if (container.text) {
      return this.deps.elementSelector().selectByText(viewHierarchy, container.text, {
        ...scopedOptions,
        intentAction: "inspect",
        screenSizeOptions: options.screenSizeOptions,
        caseSensitive: false,
      }).element as Element | undefined;
    }
    return undefined;
  }
}
