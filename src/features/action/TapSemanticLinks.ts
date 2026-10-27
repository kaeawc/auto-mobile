import { markFocusFailure, type TapOnFocusResult } from "./tapFocusResult";
import { invalidateIosCacheOnSuccess } from "./tapIosVoiceOver";
import { containerSelectorError, failedTapResult } from "./tapSharedHelpers";
import { unsupportedPlatformError } from "../../models/ActionableError";
import { type ObservedActionResult } from "./BaseVisualChange";
import {
  BootedDevice,
  Element,
  ObserveResult,
  TapOnElementResult,
  ViewHierarchyResult,
} from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient, type CtrlProxyActionResult } from "../observe/ios";
import { stableNodeSelectorForElement } from "../talkback/TalkBackTapStrategy";
import { matchesCtrlProxyNodeSelector } from "../utility/SearchableNode";
import { indeterminateTapError } from "./coordinateTapDispatch";
import { isSdkInjectedNode } from "../observe/android/StableNodeIdentity";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import type { TapOnCtrlProxy } from "./tapHierarchyRead";
import { TapTargetResolver } from "./TapTargetResolver";

export type TapOnFocusOutcome = TapOnFocusResult & {
  wasAlreadyFocused?: boolean;
  focusChanged?: boolean;
};
export function warningsField(warnings: string[]): { warnings?: string[] } {
  return warnings.length ? { warnings } : {};
}

export function withActivationWarning(warnings: string[], warning: string | undefined): string[] {
  return warning ? [...warnings, warning] : warnings;
}

type SearchUntilStats = NonNullable<TapOnElementResult["searchUntil"]>;

/** Capabilities used by this phase; dependency readers observe replacements made by tests. */
export interface TapSemanticLinksHost {
  usesCapturedOwnerIdentity(): boolean;
  usesIosLinkActivation(): boolean;
  usesAndroidLinkActivation(): boolean;
  readonly accessibilityService: () => TapOnCtrlProxy;
  activateSemanticLink: TapSemanticLinks["activateSemanticLink"];
  readonly device: () => BootedDevice;
  readonly elementParser: () => ElementParser;
  hasUniqueSemanticLinkOwner: TapSemanticLinks["hasUniqueSemanticLinkOwner"];
  resolveContainerElement: TapTargetResolver["resolveContainerElement"];
  withObservationScreenSize: TapTargetResolver["withObservationScreenSize"];
}

/** Validates selectors and activates semantic links through the selected native owner. */
export class TapSemanticLinks {
  constructor(private readonly host: TapSemanticLinksHost) {}

  createErrorResult(action: string, error: string, cause?: unknown): TapOnFocusResult {
    return markFocusFailure(action, failedTapResult(action, error), cause);
  }

  validateOptions(options: TapOnElementOptions): string | null {
    if (options.ensureChecked !== undefined && options.action !== "tap") {
      return 'tapOn ensureChecked requires action "tap"';
    }
    if (options.ensureChecked !== undefined && options.selectionStrategy === "random") {
      return "tapOn ensureChecked cannot use random selection; use a unique selector or index";
    }
    const selectorCount = [
      options.text,
      options.elementId,
      options.testTag,
      options.textAny,
      options.accessibilityLink,
    ].filter(Boolean).length;
    if (selectorCount !== 1) {
      return "tapOn requires exactly one of text, textAny, elementId, testTag, or accessibilityLink";
    }

    if (options.textAny && options.textAny.length === 0) {
      return "tapOn textAny selector must be non-empty";
    }

    const containerError = containerSelectorError(options.container, "tapOn");
    if (containerError) {
      return containerError;
    }

    return this.validateSemanticLinkOptions(options);
  }

  private validateSemanticLinkOptions(options: TapOnElementOptions): string | null {
    if (options.layer !== undefined && this.hasSemanticLinkTarget(options)) {
      // Semantic links are activated on the device across every window, so the
      // host cannot keep the activation inside the app or the prototype (#9305).
      return "tapOn layer cannot be used with accessibilityLink or subtext";
    }
    if (options.selectionStrategy === "unique" && (options.sibling || options.accessibilityLink)) {
      return "tapOn unique selection cannot use sibling or direct accessibilityLink; select a unique owner with subtext instead";
    }
    if ((options as { relativePosition?: unknown }).relativePosition !== undefined) {
      return "tapOn relativePosition is no longer supported; use accessibilityLink or subtext";
    }
    if (!this.hasSemanticLinkTarget(options)) {
      return null;
    }
    return this.semanticLinkValidationErrors(options).find(({ invalid }) => invalid)?.error ?? null;
  }

  private hasSemanticLinkTarget(options: TapOnElementOptions): boolean {
    return [options.accessibilityLink, options.subtext].some((value) => value !== undefined);
  }

  private semanticLinkValidationErrors(
    options: TapOnElementOptions,
  ): { invalid: boolean | TapOnElementOptions["searchUntil"]; error: string }[] {
    return [
      {
        invalid: [options.accessibilityLink, options.subtext].every((value) => value !== undefined),
        error: "tapOn accessibilityLink and subtext cannot be used together",
      },
      {
        invalid: options.action !== "tap",
        error: "tapOn semantic link activation supports only the tap action",
      },
      { invalid: options.sibling, error: "tapOn semantic link activation cannot use sibling" },
      {
        invalid: Boolean(options.retryIfNoChange ?? options.ensureTap),
        error: "tapOn semantic link activation cannot retry an acknowledged link activation",
      },
      {
        invalid: options.ensureChecked !== undefined,
        error: "tapOn semantic link activation cannot ensure checked state",
      },
      {
        invalid: options.searchUntil,
        error: "tapOn semantic link activation cannot use searchUntil",
      },
      {
        invalid: this.semanticLinkTextIsBlank(options),
        error: "tapOn semantic link text must be non-empty",
      },
      {
        invalid: this.semanticLinkOccurrenceIsInvalid(options),
        error: "tapOn semantic link occurrence must be a non-negative integer",
      },
      {
        invalid: options.subtext ? options.index !== undefined : false,
        error:
          "tapOn owner-scoped semantic link activation cannot use index; use a unique owner selector",
      },
      {
        invalid: options.subtext ? options.selectionStrategy === "random" : false,
        error:
          "tapOn owner-scoped semantic link activation cannot use random selection; use a unique owner selector",
      },
    ];
  }

  private semanticLinkTextIsBlank(options: TapOnElementOptions): boolean {
    return (options.subtext?.text ?? options.accessibilityLink)?.trim().length === 0;
  }

  private semanticLinkOccurrenceIsInvalid(options: TapOnElementOptions): boolean {
    const occurrence = options.subtext?.occurrence ?? options.index ?? 0;
    return ![Number.isInteger(occurrence), occurrence >= 0].every(Boolean);
  }

  async activateSemanticLink(
    text: string,
    occurrence: number,
    owner?: Element,
    viewHierarchy?: ViewHierarchyResult,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string; warning?: string }> {
    const confirmActivation = (result: CtrlProxyActionResult, invalidate: () => void): void => {
      if (result.dispatched && result.acknowledged !== true) {
        // A lost reply may mean the screen navigated; discard the pre-activation tree.
        invalidate();
        throw indeterminateTapError(result.error);
      }
    };
    if (owner && !this.host.hasUniqueSemanticLinkOwner(owner, viewHierarchy)) {
      return {
        success: false,
        error:
          "Container-scoped semantic link activation requires a unique resource-id owner identity",
      };
    }
    if (this.host.usesAndroidLinkActivation()) {
      const selector = owner ? stableNodeSelectorForElement(owner) : undefined;
      if (owner && !selector) {
        return {
          success: false,
          error:
            "Container-scoped semantic link activation requires a stable native owner identity",
        };
      }
      const result = await this.host.accessibilityService().requestActivateAccessibilityLink({
        text,
        occurrence,
        selector,
        signal,
      });
      confirmActivation(result, () => {
        AndroidCtrlProxyClient.getExistingInstance(this.host.device().deviceId)?.invalidateCache();
      });
      return { success: result.success, error: result.error };
    }
    if (this.host.usesIosLinkActivation()) {
      const ownerResourceId = owner?.["resource-id"];
      if (owner && (typeof ownerResourceId !== "string" || ownerResourceId.length === 0)) {
        return {
          success: false,
          error:
            "Container-scoped semantic link activation requires a stable native owner identity",
        };
      }
      const result = await IOSCtrlProxyClient.getInstance(
        this.host.device(),
      ).requestActivateAccessibilityLink({
        text,
        occurrence,
        ownerResourceId: ownerResourceId as string | undefined,
        signal,
      });
      confirmActivation(result, () =>
        invalidateIosCacheOnSuccess(this.host.device(), { success: true }),
      );
      invalidateIosCacheOnSuccess(this.host.device(), result);
      // The runner's "first of N candidate owners" note must reach the caller (#10082).
      return {
        success: result.success,
        error: result.error,
        warning: result.warning,
      };
    }
    return {
      success: false,
      error: unsupportedPlatformError(this.host.device().platform, "tap on elements").message,
    };
  }

  hasUniqueSemanticLinkOwner(
    owner: Element,
    viewHierarchy: ViewHierarchyResult | undefined,
  ): boolean {
    if (!viewHierarchy) {
      return false;
    }
    // The owner is resolved (ElementResolver) and natively activated across every
    // window subtree, so the uniqueness count must span the same node set. Flatten
    // with includeWindows to match — otherwise an owner in a dialog/popup/overlay is
    // miscounted: an ambiguous owner reads as unique, a valid one as absent. See #5618.
    const elements = this.host
      .elementParser()
      .flattenViewHierarchy(viewHierarchy, { includeWindows: true })
      .map(({ element }) => element);
    if (this.host.usesCapturedOwnerIdentity()) {
      const ownerResourceId = owner["resource-id"];
      return (
        typeof ownerResourceId === "string" &&
        ownerResourceId.length > 0 &&
        preferCapturedOwners(
          elements.filter((element) => element["resource-id"] === ownerResourceId),
        ).length === 1
      );
    }
    const selector = stableNodeSelectorForElement(owner);
    return (
      selector !== undefined &&
      elements.filter((element) => matchesCtrlProxyNodeSelector(element, selector)).length === 1
    );
  }

  async activateAccessibilityLinkPhase(
    options: TapOnElementOptions,
    linkText: string,
    observeResult: ObserveResult,
    viewHierarchy: ViewHierarchyResult,
    activationWarnings: string[],
    signal?: AbortSignal,
  ): Promise<TapOnFocusOutcome | ObservedActionResult> {
    const occurrence = options.index ?? 0;
    const owner = this.host.resolveContainerElement(
      viewHierarchy,
      this.host.withObservationScreenSize(options, observeResult),
    );
    if (options.container && !owner) {
      return { success: false, error: "Semantic link container is no longer present" };
    }
    const activation = await this.host.activateSemanticLink(
      linkText,
      occurrence,
      owner,
      viewHierarchy,
      signal,
    );
    if (!activation.success) {
      return { success: false, error: activation.error };
    }
    return {
      success: true,
      action: options.action,
      element: {
        text: linkText,
        bounds: { left: 0, top: 0, right: 0, bottom: 0 },
      } as Element,
      activatedSubtext: { text: linkText, occurrence },
      ...warningsField(withActivationWarning(activationWarnings, activation.warning)),
    };
  }

  async activateSubtextPhase({
    options,
    subtext,
    element,
    viewHierarchy,
    selectedElement,
    searchUntil,
    activationWarnings,
    signal,
  }: {
    options: TapOnElementOptions;
    subtext: NonNullable<TapOnElementOptions["subtext"]>;
    element: Element;
    viewHierarchy: ViewHierarchyResult;
    selectedElement: TapOnFocusResult["selectedElement"];
    searchUntil: SearchUntilStats;
    activationWarnings: string[];
    signal?: AbortSignal;
  }): Promise<TapOnFocusOutcome | ObservedActionResult> {
    const occurrence = subtext.occurrence ?? 0;
    const activation = await this.host.activateSemanticLink(
      subtext.text,
      occurrence,
      element,
      viewHierarchy,
      signal,
    );
    if (!activation.success) {
      return { success: false, error: activation.error };
    }
    return {
      success: true,
      action: options.action,
      element,
      selectedElement,
      searchUntil,
      activatedSubtext: { text: subtext.text, occurrence },
      ...warningsField(withActivationWarning(activationWarnings, activation.warning)),
    };
  }
}
/**
 * An iOS capture merges the in-app SDK snapshot into the XCUITest tree, and SDK views
 * no XCUITest node matched are injected beside it (`sdk.source=sdkWalker`). After an
 * interaction that snapshot can carry the owner's view again (the UITextView behind a
 * UILink owner), so the resource-id shows up on SDK copies too (#10843). The runner
 * resolves the owner among XCUITest elements, so when XCUITest captured the identifier,
 * the SDK copies are duplicates of it and must not make the owner ambiguous. With no
 * captured node, keep every candidate so an SDK-only identifier is still counted.
 */
function preferCapturedOwners(candidates: Element[]): Element[] {
  const captured = candidates.filter((element) => {
    const source = getHierarchyNodeSource(element);
    return !source || !isSdkInjectedNode(source);
  });
  return captured.length > 0 ? captured : candidates;
}
