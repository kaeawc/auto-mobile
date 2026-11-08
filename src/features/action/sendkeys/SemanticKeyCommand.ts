import type { BootedDevice } from "../../../models";
import type { InputKeyModifier } from "../InputKey";
import type { SendKeysCommandResult, SendKeysSemanticKey, TextActionResult } from "../SendKeys";
import { NO_FOCUSED_EDITABLE_ERROR_CODE, type FocusedInputFailure } from "./AndroidTypingConstants";
import { iosBackendFields } from "./IosSdkTextRouting";
import { semanticKeyErrorFields } from "./SemanticKeyFailure";

/** What a semantic key needs from the executor: the focus precheck and the platform dispatch. */
export interface SemanticKeyHost {
  platform: BootedDevice["platform"];
  requireFocusedInput(
    signal?: AbortSignal,
    display?: string,
  ): Promise<{ success: true } | ({ success: false } & FocusedInputFailure)>;
  dispatch(
    key: SendKeysSemanticKey,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<TextActionResult>;
  focusMayHaveMoved(): void;
}

/** Run one IME editor action (next, previous, done, search, send, go) as a command result. */
export async function executeSemanticKey(
  host: SemanticKeyHost,
  key: SendKeysSemanticKey,
  modifiers: InputKeyModifier[],
  {
    signal,
    onDispatch,
    display,
  }: { signal?: AbortSignal; onDispatch?: () => void; display?: string },
): Promise<SendKeysCommandResult> {
  const command = { index: -1, action: "key" as const, key, modifiers };
  if (host.platform === "android") {
    const focusResult = await host.requireFocusedInput(signal, display);
    if (!focusResult.success) {
      return {
        ...command,
        success: false,
        error: focusResult.error,
        errorCode: focusResult.errorCode ?? NO_FOCUSED_EDITABLE_ERROR_CODE,
      };
    }
  }
  const result = await host.dispatch(key, signal, onDispatch);
  host.focusMayHaveMoved();
  return {
    ...command,
    ...("iosBackend" in result ? iosBackendFields(result.iosBackend) : {}),
    success: result.success,
    ...(result.retryable === false ? { retryable: false } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
    ...semanticKeyErrorFields(host.platform, key, result),
  };
}
