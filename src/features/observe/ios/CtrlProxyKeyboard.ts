import { sendIOSPressCommand, type IOSDispatchResult } from "./CtrlProxyDispatch";
/**
 * CtrlProxyKeyboard - iOS keyboard delegate.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { InputKeyModifier, InputKeyName } from "../../action/InputKey";
import type { DelegateContext, CtrlProxyKeyboardResult, CtrlProxyPressKeyResult } from "./types";
import { sendCommand } from "../DeviceServiceUtils";

// Runner's 6000ms arrow budget plus headroom for an in-flight XCUITest call and response.
export const IOS_ARROW_PRESS_KEY_TIMEOUT_MS = 9000;
// Forward delete can retry Right Arrow + caret probe before its 1s post-condition poll.
export const IOS_DELETE_PRESS_KEY_TIMEOUT_MS = 11000;
export const IOS_DEFAULT_PRESS_KEY_TIMEOUT_MS = 5000;

export function pressKeyTimeoutMs(key: InputKeyName, timeoutMs?: number): number {
  if (timeoutMs !== undefined) {
    return timeoutMs;
  }
  if (key === "arrow_left" || key === "arrow_right") {
    return IOS_ARROW_PRESS_KEY_TIMEOUT_MS;
  }
  return key === "delete" ? IOS_DELETE_PRESS_KEY_TIMEOUT_MS : IOS_DEFAULT_PRESS_KEY_TIMEOUT_MS;
}

export class CtrlProxyKeyboard {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  async requestKeyboard(
    action: "open" | "close" | "detect",
    timeoutMs: number = action === "close" ? 8000 : 5000,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyKeyboardResult> {
    return sendCommand<CtrlProxyKeyboardResult>(this.context, {
      idPrefix: "keyboard",
      responseType: "keyboard",
      messageType: "request_keyboard",
      params: { action },
      timeoutMs,
      perf,
      errorLabel: "Keyboard",
      abortSignal: signal,
      notConnectedError: () => ({
        success: false,
        open: false,
        totalTimeMs: 0,
        error: "Not connected",
      }),
      unsupportedCommandError: (_messageType, error) => ({
        success: false,
        open: false,
        totalTimeMs: 0,
        error,
      }),
      timeoutError: (timeout) => ({
        success: false,
        open: false,
        totalTimeMs: timeout,
        error: `Keyboard timed out after ${timeout}ms`,
      }),
    });
  }

  async requestPressKey(
    key: InputKeyName,
    modifiers: InputKeyModifier[],
    timeoutMs?: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<CtrlProxyPressKeyResult>> {
    return sendIOSPressCommand(this.context, {
      idPrefix: "pressKey",
      responseType: "press_key",
      messageType: "request_press_key",
      params: { key, modifiers },
      timeoutMs: pressKeyTimeoutMs(key, timeoutMs),
      abortSignal: signal,
      perf,
      onDispatch,
      errorLabel: "Press key",
    });
  }
}
