import type { ObserveResult } from "../../../models";
import { getFocusedTextFieldIdentity, hasFocusedTextInput } from "../ClearText";
import type { SendKeysResult } from "../SendKeys";

/** No field text is retained, including for password editors. Missing signals stay unknown. */
export interface ImeEditorState {
  display?: string;
  focused?: boolean;
  field?: string;
  keyboardVisible?: boolean;
}

export function readImeEditorState(observation: ObserveResult): ImeEditorState {
  const hierarchy = observation.viewHierarchy;
  const readable = hierarchy && !hierarchy.hierarchy.error && !hierarchy.ctrlProxyIncomplete;
  const windows = readable ? hierarchy.windows : undefined;
  return {
    display: observation.display.key,
    focused: readable ? hasFocusedTextInput(hierarchy) : undefined,
    field: readable ? getFocusedTextFieldIdentity(hierarchy) : undefined,
    // Android AccessibilityWindowInfo.TYPE_INPUT_METHOD is 2. Without captured
    // window metadata, absence of the compact keyboard summary proves nothing.
    keyboardVisible:
      observation.keyboard?.visible ??
      (windows?.length && windows.every((window) => window.type !== undefined)
        ? windows.some((window) => window.type === 2)
        : undefined),
  };
}

export function withImeEditorWarnings(
  result: SendKeysResult,
  before?: ImeEditorState,
): SendKeysResult {
  // Explicit keys may intentionally move focus or dismiss/submit the composer.
  if (
    !before ||
    !result.observation ||
    !result.commands.some(
      (entry) => entry.action === "type" && entry.backend === "autoMobileIme",
    ) ||
    result.commands.some((entry) => entry.action === "key")
  ) {
    return result;
  }
  const warnings = imeEditorWarnings(before, result.observation);
  return warnings.length ? { ...result, warnings } : result;
}

/** Whether a sampled keyboard disappearance needs confirmation after the IME window settles. */
export function hasImeKeyboardHiddenChange(
  before: ImeEditorState | undefined,
  observation: ObserveResult,
): boolean {
  const after = readImeEditorState(observation);
  return (
    before?.display === after.display &&
    before?.keyboardVisible === true &&
    after.keyboardVisible === false
  );
}

/** Reports sampled state changes; callers settle keyboard disappearance before reporting it. */
export function imeEditorWarnings(before: ImeEditorState, observation: ObserveResult): string[] {
  const after = readImeEditorState(observation);
  if (before.display !== after.display) {
    return [];
  }
  const changes: string[] = [];
  if (before.focused && after.focused === false) {
    changes.push("the focused editor lost focus");
  } else if (before.field && after.field && before.field !== after.field) {
    changes.push("the focused editor changed");
  }
  if (before.keyboardVisible && after.keyboardVisible === false) {
    changes.push("the keyboard became hidden");
  }
  return changes.length
    ? [
        `After IME typing, ${changes.join(" and ")}. Inspect the field before retrying to avoid duplicate text; refocus the field and retry with mode "a11y" (which does not switch the keyboard), or use visible key taps if needed.`,
      ]
    : [];
}
