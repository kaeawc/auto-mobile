import type { Element } from "../../models";
import { logger } from "../../utils/logger";
import { isFocusEditableElement } from "../utility/ElementResolver";
import { tapFocusFailure, type TapFocusFailure } from "./tapFocusResult";

/** What chip activation needs from setUIState: a tap on the chip and a fresh copy of it. */
export interface TextChipActivationDeps {
  selectorDesc: string;
  tap: () => Promise<{ success: boolean; error?: string }>;
  refresh: () => Promise<Element>;
  signal?: AbortSignal;
}

/** Focusing additionally needs the verified focus action. */
export interface TextFieldFocusDeps extends TextChipActivationDeps {
  focus: (target: Element) => Promise<{
    success: boolean;
    focusVerified?: boolean;
    error?: string;
    [tapFocusFailure]?: TapFocusFailure;
  }>;
}

/** A failed text-field step, in setUIState's field-application shape. */
export interface TextFieldFocusFailure {
  success: false;
  error: string;
  /** The same attempt would fail the same way, so retrying only wastes time (#18538). */
  stopRetrying?: boolean;
}

export type TextChipActivation = { element: Element } | { error: string };

/**
 * A checkable text chip (Material time-picker minute, #18350) has no editable
 * affordance until it is tapped, and the focus action resolves only editable
 * nodes. Tap the chip, re-observe, and return the node that now edits. Any other
 * element is returned unchanged.
 */
export async function activateTextChip(
  element: Element,
  deps: TextChipActivationDeps,
): Promise<TextChipActivation> {
  const checkable = element.checkable === true || element.checkable === "true";
  if (!checkable || isFocusEditableElement(element)) {
    return { element };
  }
  logger.debug(`[SetUIState] text.activate selector=${deps.selectorDesc}`);
  const tapResult = await deps.tap();
  deps.signal?.throwIfAborted();
  if (!tapResult.success) {
    return { error: `Failed to activate text chip: ${tapResult.error}` };
  }
  const refreshed = await deps.refresh();
  deps.signal?.throwIfAborted();
  if (!isFocusEditableElement(refreshed)) {
    return {
      error:
        `${deps.selectorDesc} did not become an editable field after it was tapped. ` +
        "Tap it with tapOn and type with sendKeys.",
    };
  }
  return { element: refreshed };
}

/**
 * Activate a text chip if needed, then focus the field. Returns the failure to
 * report, or null once this field verifiably owns input.
 */
export async function focusForInput(
  element: Element,
  deps: TextFieldFocusDeps,
): Promise<TextFieldFocusFailure | null> {
  const activation = await activateTextChip(element, deps);
  if ("error" in activation) {
    return { success: false, error: activation.error };
  }

  // The focus action verifies that this editable field, rather than a
  // previously focused field, owns input before ClearText can mutate it.
  logger.debug(`[SetUIState] text.focus selector=${deps.selectorDesc}`);
  const tapStart = Date.now();
  const tapResult = await deps.focus(activation.element);
  deps.signal?.throwIfAborted();
  logger.debug(
    `[SetUIState] text.focus done selector=${deps.selectorDesc} success=${tapResult.success} focusVerified=${tapResult.focusVerified === true} totalMs=${Date.now() - tapStart}${tapResult.error ? ` error=${tapResult.error}` : ""}`,
  );
  if (!tapResult.success || tapResult.focusVerified !== true) {
    return {
      success: false,
      error: `Failed to tap/focus on field: ${tapResult.error ?? "focus was not verified"}`,
      // A selector that matched a visible non-input keeps matching it until the caller taps it
      // first, so a retry repeats the same refusal (#18538).
      ...(tapResult[tapFocusFailure] === "matched-non-input" ? { stopRetrying: true } : {}),
    };
  }
  return null;
}
