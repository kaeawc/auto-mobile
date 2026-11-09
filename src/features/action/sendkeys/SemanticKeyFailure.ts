import type { BootedDevice } from "../../../models";
import type { SendKeysSemanticKey } from "../SendKeys";

/** Stable code for a semantic key the focused editor did not carry out (#17463). */
export const EDITOR_ACTION_MISMATCH_ERROR_CODE = "EDITOR_ACTION_MISMATCH";

/** CtrlProxy's reply when the editor action or its focus-traversal stand-in returned false. */
const GENERIC_DEVICE_FAILURE = "Action failed";

function alternatives(key: SendKeysSemanticKey): string {
  switch (key) {
    case "next":
      return 'Use key:"tab" to move focus, or sendKeys with a selector for the next field.';
    case "previous":
      return "Use sendKeys with a selector for the previous field.";
    default:
      // Enter may submit, but a multiline field can take it as a newline instead.
      return 'Tap the screen\'s submit control if there is one; otherwise key:"enter" may submit, though a multiline field can insert a newline instead. Observe the result before retrying.';
  }
}

function cause(key: SendKeysSemanticKey, traversed: boolean): string {
  if (traversed) {
    // The AutoMobile IME was not the active keyboard, so CtrlProxy looked for a neighbour itself.
    return `no ${key === "previous" ? "previous" : "next"} focusable field was found beside the focused field`;
  }
  if (key === "next" || key === "previous") {
    return `the focused field did not perform the "${key}" editor action; its configured action may be another one, such as done`;
  }
  // Below API 30 CtrlProxy injects KEYCODE_ENTER, and a failed injection reports the same reply,
  // so the field may not have received the action at all.
  return `the device reported the "${key}" action as not performed; the field may not accept it, or the key could not be delivered`;
}

/**
 * Replace CtrlProxy's bare "Action failed" for a semantic key with a typed, actionable failure.
 * The capture carries no `imeOptions`, so the message names what was tried and what to use
 * instead rather than claiming the field's configured action. A device error that already says
 * why (no focused editable node, an unsupported action, a transport failure) is kept as is.
 */
export function semanticKeyFailure(
  key: SendKeysSemanticKey,
  result: { error?: string; approximated?: boolean },
): { error: string; errorCode: string } | undefined {
  const deviceError = result.error?.trim();
  if (deviceError !== undefined && deviceError !== "" && deviceError !== GENERIC_DEVICE_FAILURE) {
    return undefined;
  }
  return {
    error: `key "${key}" was not applied: ${cause(key, result.approximated === true)}. ${alternatives(key)}`,
    errorCode: EDITOR_ACTION_MISMATCH_ERROR_CODE,
  };
}

/** The error fields of a semantic key's command result: typed on Android, passed through elsewhere. */
export function semanticKeyErrorFields(
  platform: BootedDevice["platform"],
  key: SendKeysSemanticKey,
  result: { success: boolean; error?: string; approximated?: boolean },
): { error?: string; errorCode?: string } {
  const typed =
    platform === "android" && !result.success ? semanticKeyFailure(key, result) : undefined;
  return typed ?? (result.error ? { error: result.error } : {});
}
