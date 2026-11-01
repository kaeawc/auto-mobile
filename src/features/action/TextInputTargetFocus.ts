import { BootedDevice } from "../../models";
import { TapOnElement } from "./TapOnElement";

/** Selector variants that identify a field to focus before typing (issue #5872). */
export interface TextInputTargetSelector {
  elementId?: string;
  testTag?: string;
  text?: string;
  textAny?: string[];
}

/**
 * Focuses the field a `selector` names before {@link InputText} types into it,
 * collapsing the mandatory focus-then-type pair into one call (issue #5872 AC3).
 * Interface + fake so the focus step is unit-testable without a real tap.
 */
export interface TextInputTargetFocuser {
  focus(
    selector: TextInputTargetSelector,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    error?: string;
    focusVerified?: boolean;
    matchedId?: string;
    matchedText?: string;
  }>;
}

export type TextInputTargetFocuserFactory = (device: BootedDevice) => TextInputTargetFocuser;

export function isFocusResultConfirmed(
  result: Awaited<ReturnType<TextInputTargetFocuser["focus"]>>,
): boolean {
  // The focuser verifies the selected field's own keyboard focus or its nearest
  // editable ancestor/descendant before any text is sent.
  return result.success && result.focusVerified === true;
}

export function describeFocusTarget(
  result: Awaited<ReturnType<TextInputTargetFocuser["focus"]>>,
  selector: TextInputTargetSelector,
): string {
  const target =
    result.matchedText ??
    selector.text ??
    selector.textAny?.[0] ??
    selector.elementId ??
    selector.testTag;
  return target ? JSON.stringify(target) : "for the selector";
}

export const defaultTargetFocuserFactory: TextInputTargetFocuserFactory = (device) => ({
  focus: async (selector, signal) => {
    const result = await new TapOnElement(device).execute(
      { ...selector, action: "focus" },
      { signal },
    );
    return {
      success: result.success,
      error: result.error,
      focusVerified: result.focusVerified === true,
      matchedId: result.selectedElement?.resourceId,
      matchedText: result.selectedElement?.text,
    };
  },
});
