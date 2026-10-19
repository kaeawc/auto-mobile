/**
 * SetUIStateFieldApplier - locate, fill and verify a single form field.
 *
 * Extracted from SetUIState (max-class-lines): element lookup, focus, text/selected/
 * dropdown application and post-apply verification. Reads SetUIState's collaborators
 * through a {@link SetUIStateFieldContext} provider so lazily created tools stay shared.
 */

import type { ScreenSizeForOffscreenCheckOptions } from "../../models/ScreenSize";
import { errorMessage } from "../../utils/describeUnknownError";
import { ProgressCallback } from "./BaseVisualChange";
import { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../../models";
import { FieldSpec, SetUIStateElementSelector } from "../../models/SetUIStateOptions";
import { FieldType } from "../../models/SetUIStateResult";
import { FieldTypeDetector } from "./FieldTypeDetector";
import type { Keyboard } from "./Keyboard";
import { KeyboardOcclusionError } from "../../models/KeyboardOcclusionError";
import { ActionableError } from "../../models/ActionableError";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";
import {
  CONTAINS_IGNORE_CASE,
  FOCUS_INPUT_INSPECT_INTENT,
  FOCUS_INPUT_INTENT,
  FOCUS_INPUT_WITH_HINT_FALLBACK,
  INSPECT_INTENT,
  TOGGLE_INSPECT_INTENT,
} from "../utility/SelectionPolicy";
import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";
import { Timer } from "../../utils/SystemTimer";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import type {
  ClearTextLike,
  FieldApplicationResult,
  FieldValueVerification,
  FieldVerificationOutcome,
  InputTextLike,
  TapOnElementLike,
  TextFocusRecovery,
} from "./SetUIState";

// Dropdown controls need time to open before selection.
export const DROPDOWN_OPEN_SETTLE_MS = 200;

export interface SetUIStateFieldContext {
  fieldTypeDetector: FieldTypeDetector;
  selector: ResolverElementSelector;
  device: BootedDevice;
  timer: Timer;
  getKeyboard(): Pick<Keyboard, "execute">;
  getTapOnElement(): TapOnElementLike;
  getInputText(): InputTextLike;
  getClearText(): ClearTextLike;
  getObserveScreen(): ObserveScreen;
}

export class SetUIStateFieldApplier {
  constructor(private readonly ctx: () => SetUIStateFieldContext) {}

  async verifyAppliedFieldValue(
    fieldSpec: FieldSpec,
    fieldType: FieldType,
    element: Element,
    attempts: number,
    signal?: AbortSignal,
  ): Promise<FieldVerificationOutcome> {
    if (this.shouldSkipFieldVerification(fieldSpec, fieldType, element)) {
      return {};
    }

    const verifyResult = await this.verifyFieldValue(fieldSpec, fieldType, signal, element);
    if (verifyResult.unverifiable) {
      return { observation: verifyResult.observation };
    }
    if (verifyResult.verified) {
      return { verified: true, observation: verifyResult.observation };
    }

    return {
      error:
        `Verification failed for ${this.describeSelector(fieldSpec.selector)}: ` +
        `expected ${JSON.stringify(fieldType === "toggle" || fieldType === "checkbox" ? fieldSpec.selected : fieldSpec.value)}, ` +
        `observed ${JSON.stringify(verifyResult.observedValue)}`,
      stopRetrying: fieldType === "text" && attempts >= 2,
    };
  }

  private shouldSkipFieldVerification(
    fieldSpec: FieldSpec,
    fieldType: FieldType,
    element: Element,
  ): boolean {
    if (
      this.ctx().fieldTypeDetector.isPasswordField(element) ||
      this.ctx().fieldTypeDetector.shouldSkipVerification(element, fieldType)
    ) {
      return true;
    }

    return (
      fieldType !== "text" &&
      fieldType === "dropdown" &&
      fieldSpec.selector.text !== undefined &&
      fieldSpec.selector.elementId === undefined
    );
  }

  async refreshFieldElement(
    fieldSpec: FieldSpec,
    previousElement: Element,
    signal?: AbortSignal,
  ): Promise<Element> {
    const observation = await this.ctx().getObserveScreen().execute({
      signal,
      skipWaitForFresh: false,
      minTimestamp: 0,
    });
    if (!observation?.viewHierarchy) {
      return previousElement;
    }

    const found = this.findElement(
      {
        ...fieldSpec.selector,
        screenSizeOptions: {
          observationScreenSize: observation.screenSize,
          display: observation.viewHierarchy,
        },
      },
      observation.viewHierarchy,
      fieldSpec.selected !== undefined,
    );
    if (found) {
      return found;
    }

    const resourceId = previousElement["resource-id"];
    if (fieldSpec.selector.text && resourceId) {
      return (
        this.findByResourceId(observation.viewHierarchy, resourceId, {
          observationScreenSize: observation.screenSize,
          display: observation.viewHierarchy,
        }) ?? previousElement
      );
    }
    return previousElement;
  }

  /**
   * Resolves the element a selector names without acting on it; public for tests (null if none).
   */
  findElement(
    selector: SetUIStateElementSelector & {
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
    viewHierarchy?: ViewHierarchyResult,
    wantsCheckable = false,
  ): Element | null {
    if (!viewHierarchy) {
      return null;
    }

    if (selector.text) {
      const control = wantsCheckable
        ? this.findCheckableByText(selector.text, viewHierarchy, selector.screenSizeOptions)
        : null;
      if (control) {
        return control;
      }
      if (this.ctx().device.platform === "ios") {
        return (
          this.ctx().selector.select(
            viewHierarchy,
            { text: selector.text },
            {
              ...FOCUS_INPUT_INSPECT_INTENT,
              screenSizeOptions: selector.screenSizeOptions,
            },
          ).element ?? null
        );
      }
      return this.findAndroidTextElement(selector.text, viewHierarchy, selector.screenSizeOptions);
    }

    if (selector.elementId) {
      return this.findByResourceId(viewHierarchy, selector.elementId, selector.screenSizeOptions);
    }

    return null;
  }

  /**
   * A `selected` request names a control by its visible label, which usually sits on a
   * clickable row that owns the checkable widget (Settings switch and radio rows, #10616).
   * The toggle intent resolves the checkable node the matched label or row encloses; a
   * match that is not checkable falls back to the ordinary field lookup.
   */
  private findCheckableByText(
    text: string,
    viewHierarchy: ViewHierarchyResult,
    screenSizeOptions?: ScreenSizeForOffscreenCheckOptions,
  ): Element | null {
    const android = this.ctx().device.platform !== "ios";
    const element = this.ctx().selector.select(
      viewHierarchy,
      { text },
      {
        ...TOGGLE_INSPECT_INTENT,
        ...(android ? CONTAINS_IGNORE_CASE : {}),
        screenSizeOptions,
      },
    ).element;
    if (!element) {
      return null;
    }
    const fieldType = this.ctx().fieldTypeDetector.detect(element);
    return fieldType === "toggle" || fieldType === "checkbox" ? element : null;
  }

  /**
   * The field node an ID names. `inspect` keeps the node itself (no tap-owner
   * promotion) and the resolver deduplicates one field serialized in multiple roots.
   */
  private findByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    screenSizeOptions?: ScreenSizeForOffscreenCheckOptions,
  ): Element | null {
    return (
      this.ctx().selector.select(
        viewHierarchy,
        { elementId: resourceId },
        {
          ...INSPECT_INTENT,
          screenSizeOptions,
        },
      ).element ?? null
    );
  }

  private findAndroidTextElement(
    text: string,
    viewHierarchy: ViewHierarchyResult,
    screenSizeOptions?: ScreenSizeForOffscreenCheckOptions,
  ): Element | null {
    const matched = this.ctx().selector.select(
      viewHierarchy,
      { text },
      {
        ...INSPECT_INTENT,
        ...CONTAINS_IGNORE_CASE,
        screenSizeOptions,
      },
    ).element;
    if (!matched) {
      return this.ctx().selector.select(
        viewHierarchy,
        { text },
        {
          ...FOCUS_INPUT_WITH_HINT_FALLBACK,
          screenSizeOptions,
        },
      ).element;
    }
    // Preserve legacy matching and all classified controls. Only an unclassified
    // label may use the same bounded label-to-input promotion as sendKeys.
    if (this.ctx().fieldTypeDetector.detect(matched) !== "unknown") {
      return matched;
    }
    const identity = matched["resource-id"] || matched["view-id"];
    const focusOptions = {
      ...FOCUS_INPUT_INTENT,
      screenSizeOptions,
    };
    let focused = identity
      ? this.ctx().selector.select(viewHierarchy, { elementId: identity }, focusOptions)
      : this.ctx().selector.select(
          viewHierarchy,
          { text },
          {
            ...focusOptions,
            ...CONTAINS_IGNORE_CASE,
          },
        );
    const source = getHierarchyNodeSource(matched);
    if (identity && source !== getHierarchyNodeSource(focused.matchedElement ?? matched)) {
      // Legacy text search prefers hierarchy; the resolver may choose a separately
      // deserialized window copy. Retry that primary tree, then require exact source equality.
      focused = this.ctx().selector.select(
        { ...resolveViewHierarchyForSearch(viewHierarchy)!, windows: undefined },
        { elementId: identity },
        focusOptions,
      );
    }
    return source &&
      focused.matchedElement &&
      source === getHierarchyNodeSource(focused.matchedElement)
      ? (focused.element ?? matched)
      : matched;
  }

  /**
   * Check if field already has the correct value
   */
  isFieldAlreadyCorrect(element: Element, fieldSpec: FieldSpec, fieldType: FieldType): boolean {
    switch (fieldType) {
      case "text":
        if (fieldSpec.value !== undefined) {
          const currentValue = this.ctx().fieldTypeDetector.getTextValue(element);
          return currentValue === fieldSpec.value;
        }
        return false;

      case "checkbox":
      case "toggle":
        if (fieldSpec.selected !== undefined) {
          const isChecked = this.ctx().fieldTypeDetector.isChecked(element);
          return isChecked === fieldSpec.selected;
        }
        return false;

      case "dropdown":
        if (fieldSpec.value !== undefined) {
          const currentValue = this.ctx().fieldTypeDetector.getTextValue(element);
          return currentValue === fieldSpec.value;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Make one Android IME recovery attempt per field, preserving the original refusal.
   */
  private async focusTextField(
    element: Element,
    fieldSpec: FieldSpec,
    recovery: TextFocusRecovery,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): ReturnType<TapOnElementLike["execute"]> {
    const focus = (target: Element) =>
      this.ctx()
        .getTapOnElement()
        .execute(
          target["resource-id"]
            ? { elementId: target["resource-id"], action: "focus" }
            : this.buildTapOptions(fieldSpec.selector, "focus"),
          { progress, signal, recovery: { throwOnKeyboardOcclusion: true } },
        );
    try {
      return await focus(element);
    } catch (error) {
      throwIfAborted(signal);
      if (this.ctx().device.platform !== "android" || !(error instanceof KeyboardOcclusionError)) {
        // Preserve the field-error contract while keeping thrown errors structured.
        throw error instanceof ActionableError
          ? error
          : new ActionableError(errorMessage(error), { cause: error });
      }
      if (recovery.occlusionError) {
        logger.warn("[SetUIState] IME recovery failed", error);
        throw recovery.occlusionError;
      }
      recovery.occlusionError = error;
      logger.debug("[SetUIState] Text field is covered by the IME; closing the keyboard", error);
      try {
        const dismissal = await this.ctx().getKeyboard().execute("close", { signal });
        throwIfAborted(signal);
        if (!dismissal.success) {
          throw error;
        }
        const refreshed = await this.refreshFieldElement(fieldSpec, element, signal);
        throwIfAborted(signal);
        const result = await focus(refreshed);
        throwIfAborted(signal);
        if (!result.success || result.focusVerified !== true) {
          throw error;
        }
        return result;
      } catch (recoveryError) {
        throwIfAborted(signal);
        logger.warn("[SetUIState] IME recovery failed", recoveryError);
        throw error;
      }
    }
  }

  /**
   * Apply value to field based on type
   */
  async applyFieldValue(
    element: Element,
    fieldSpec: FieldSpec,
    fieldType: FieldType,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    focusRecovery: TextFocusRecovery = {},
  ): Promise<FieldApplicationResult> {
    const tapOnElement = this.ctx().getTapOnElement();
    const inputText = this.ctx().getInputText();
    const clearText = this.ctx().getClearText();

    try {
      switch (fieldType) {
        case "text":
          return await this.applyTextFieldValue({
            element,
            fieldSpec,
            focusRecovery,
            progress,
            signal,
            inputText,
            clearText,
          });

        case "checkbox":
        case "toggle":
          return await this.applySelectedFieldValue(
            element,
            fieldSpec,
            tapOnElement,
            progress,
            signal,
          );

        case "dropdown":
          return await this.applyDropdownFieldValue(fieldSpec, tapOnElement, progress, signal);

        default:
          // Name what was actually matched: this is normally a label rather than
          // the input itself, and "Unknown field type: unknown" describes an
          // internal state the caller cannot act on (#4242).
          return {
            success: false,
            unclassifiable: true,
            error:
              `Cannot set ${this.describeSelector(fieldSpec.selector)}: matched an element that is not ` +
              `an editable field (detected type "${fieldType}"). Select the input rather than its label.`,
          };
      }
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[SetUIState] Failed to apply field value: ${errorMessage(error)}`, error);
      return {
        success: false,
        error: errorMessage(error),
        stopRetrying: error instanceof KeyboardOcclusionError,
      };
    }
  }

  private async applyTextFieldValue({
    element,
    fieldSpec,
    focusRecovery,
    progress,
    signal,
    inputText,
    clearText,
  }: {
    element: Element;
    fieldSpec: FieldSpec;
    focusRecovery: TextFocusRecovery;
    progress?: ProgressCallback;
    signal?: AbortSignal;
    inputText: InputTextLike;
    clearText: ClearTextLike;
  }): Promise<FieldApplicationResult> {
    if (fieldSpec.value === undefined) {
      return { success: false, error: "value is required for text fields" };
    }

    const selectorDesc = this.describeSelector(fieldSpec.selector);

    // The focus action verifies that this editable field, rather than a
    // previously focused field, owns input before ClearText can mutate it.
    logger.debug(`[SetUIState] text.focus selector=${selectorDesc}`);
    const tapStart = Date.now();
    const tapResult = await this.focusTextField(
      element,
      fieldSpec,
      focusRecovery,
      progress,
      signal,
    );
    signal?.throwIfAborted();
    logger.debug(
      `[SetUIState] text.focus done selector=${selectorDesc} success=${tapResult.success} focusVerified=${tapResult.focusVerified === true} totalMs=${Date.now() - tapStart}${tapResult.error ? ` error=${tapResult.error}` : ""}`,
    );
    if (!tapResult.success || tapResult.focusVerified !== true) {
      return {
        success: false,
        error: `Failed to tap/focus on field: ${tapResult.error ?? "focus was not verified"}`,
      };
    }

    // Clear existing text
    logger.debug(`[SetUIState] text.clear selector=${selectorDesc}`);
    const clearStart = Date.now();
    signal?.throwIfAborted();
    const clearResult = await clearText.execute(progress, signal);
    if (clearResult.retryable !== false) {
      signal?.throwIfAborted();
    }
    logger.debug(
      `[SetUIState] text.clear done selector=${selectorDesc} success=${clearResult.success} totalMs=${Date.now() - clearStart}${clearResult.error ? ` error=${clearResult.error}` : ""}`,
    );
    if (!clearResult.success) {
      return {
        success: false,
        error: `Failed to clear text: ${clearResult.error}`,
        stopRetrying: clearResult.retryable === false,
      };
    }

    const inputResult = await this.inputFieldText(fieldSpec, selectorDesc, inputText, signal);
    return {
      ...inputResult,
      warnings: clearResult.warnings,
    };
  }

  private async inputFieldText(
    fieldSpec: FieldSpec,
    selectorDesc: string,
    inputText: InputTextLike,
    signal?: AbortSignal,
  ): Promise<FieldApplicationResult> {
    // Input new text. Intentionally passes no mode so the shared
    // InputText.execute applies event-all marker auto-promotion here too
    // (a form field value containing a configured marker, e.g. an
    // @mention, is typed via eventAll). This is by design — the feature
    // is scoped to both the internal text-input primitive and setUIState text fields.
    logger.debug(
      `[SetUIState] text.input selector=${selectorDesc} textLength=${fieldSpec.value!.length}`,
    );
    const inputStart = Date.now();
    signal?.throwIfAborted();
    const inputResult = await inputText.execute(
      fieldSpec.value!,
      undefined,
      false,
      undefined,
      signal,
    );
    if (inputResult.retryable !== false) {
      signal?.throwIfAborted();
    }
    logger.debug(
      `[SetUIState] text.input done selector=${selectorDesc} success=${inputResult.success} totalMs=${Date.now() - inputStart}${inputResult.error ? ` error=${inputResult.error}` : ""}`,
    );
    if (!inputResult.success) {
      return {
        success: false,
        error: `Failed to input text: ${inputResult.error}`,
        stopRetrying: inputResult.retryable === false,
      };
    }

    return { success: true };
  }

  private async applySelectedFieldValue(
    element: Element,
    fieldSpec: FieldSpec,
    tapOnElement: TapOnElementLike,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<FieldApplicationResult> {
    if (fieldSpec.selected === undefined) {
      return { success: false, error: "selected is required for checkbox/toggle fields" };
    }

    // Check current state
    const isChecked = this.ctx().fieldTypeDetector.isChecked(element);

    // Only tap if state needs to change
    if (isChecked !== fieldSpec.selected) {
      const tapResult = await tapOnElement.execute(
        this.buildTapOptions(fieldSpec.selector, "tap"),
        { progress, signal },
      );
      if (!tapResult.success) {
        return { success: false, error: `Failed to tap checkbox/toggle: ${tapResult.error}` };
      }
    }

    return { success: true };
  }

  private async applyDropdownFieldValue(
    fieldSpec: FieldSpec,
    tapOnElement: TapOnElementLike,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<FieldApplicationResult> {
    if (fieldSpec.value === undefined) {
      return { success: false, error: "value is required for dropdown fields" };
    }

    // Tap to open dropdown
    const openResult = await tapOnElement.execute(this.buildTapOptions(fieldSpec.selector, "tap"), {
      progress,
      signal,
    });
    if (!openResult.success) {
      return { success: false, error: `Failed to open dropdown: ${openResult.error}` };
    }

    // Wait a bit for dropdown to open
    await this.ctx().timer.sleep(DROPDOWN_OPEN_SETTLE_MS);

    // Tap on the desired value
    const selectResult = await tapOnElement.execute(
      { text: fieldSpec.value, action: "tap" },
      { progress, signal },
    );
    if (!selectResult.success) {
      return {
        success: false,
        error: `Failed to select dropdown value: ${selectResult.error}`,
      };
    }

    return { success: true };
  }

  /**
   * Verify field value after setting
   */
  private async verifyFieldValue(
    fieldSpec: FieldSpec,
    fieldType: FieldType,
    signal?: AbortSignal,
    previouslyMatchedElement?: Element,
  ): Promise<FieldValueVerification> {
    // Get fresh observation. The caller (processField -> execute) reuses this
    // as its own post-success refresh instead of issuing a second, effectively
    // redundant observe against the device (#6222).
    const observation = await this.ctx().getObserveScreen().execute({
      signal,
      skipWaitForFresh: false,
      minTimestamp: 0,
    });
    if (!observation?.viewHierarchy) {
      if (fieldType === "text") {
        return { verified: false, observation, unverifiable: true };
      }
      return { verified: false, observation };
    }

    // Find the element again
    let element = this.findElement(
      {
        ...fieldSpec.selector,
        screenSizeOptions: {
          observationScreenSize: observation.screenSize,
          display: observation.viewHierarchy,
        },
      },
      observation.viewHierarchy,
      fieldSpec.selected !== undefined,
    );
    // A text selector can name the field's current label/value, which changes
    // after input. Prefer the matched field's stable resource ID in the fresh
    // hierarchy when the original text no longer identifies it.
    const resourceId = previouslyMatchedElement?.["resource-id"];
    if (!element && resourceId) {
      element = this.findByResourceId(observation.viewHierarchy, resourceId, {
        observationScreenSize: observation.screenSize,
        display: observation.viewHierarchy,
      });
    }
    if (!element) {
      if (fieldType === "text") {
        return { verified: false, observation, unverifiable: true };
      }
      return { verified: false, observation };
    }

    return this.verifyObservedFieldValue(fieldSpec, fieldType, element, observation);
  }

  private verifyObservedFieldValue(
    fieldSpec: FieldSpec,
    fieldType: FieldType,
    element: Element,
    observation: ObserveResult,
  ): FieldValueVerification {
    // Verify based on field type
    switch (fieldType) {
      case "text":
        if (fieldSpec.value !== undefined) {
          const observedValue = this.ctx().fieldTypeDetector.getTextValue(element);
          return { verified: observedValue === fieldSpec.value, observation, observedValue };
        }
        return { verified: true, observation };

      case "checkbox":
      case "toggle":
        if (fieldSpec.selected !== undefined) {
          const isChecked = this.ctx().fieldTypeDetector.isChecked(element);
          return {
            verified: isChecked === fieldSpec.selected,
            observation,
            observedValue: isChecked,
          };
        }
        return { verified: true, observation };

      case "dropdown":
        if (fieldSpec.value !== undefined) {
          const currentValue = this.ctx().fieldTypeDetector.getTextValue(element);
          return { verified: currentValue === fieldSpec.value, observation };
        }
        return { verified: true, observation };

      default:
        return { verified: true, observation };
    }
  }

  /**
   * Build tap options from selector
   */
  private buildTapOptions(
    selector: SetUIStateElementSelector,
    action: string,
  ): { text?: string; elementId?: string; action: string } {
    if (selector.text) {
      return { text: selector.text, action };
    }
    return { elementId: selector.elementId, action };
  }

  /**
   * Describe a selector for error messages
   */
  describeSelector(selector: SetUIStateElementSelector): string {
    if (selector.text) {
      return `text="${selector.text}"`;
    }
    if (selector.elementId) {
      return `elementId="${selector.elementId}"`;
    }
    return "unknown selector";
  }
}
