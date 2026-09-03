/**
 * CtrlProxyKeyboard - iOS keyboard delegate.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { InputKeyModifier, InputKeyName } from "../../action/InputKey";
import type {
  DelegateContext,
  CtrlProxyKeyboardResult,
  CtrlProxyPressKeyResult,
} from "./types";
import { sendCommand } from "../DeviceServiceUtils";

export class CtrlProxyKeyboard {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  async requestKeyboard(
    action: "open" | "close" | "detect",
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyKeyboardResult> {
    return sendCommand<CtrlProxyKeyboardResult>(this.context, {
      idPrefix: "keyboard",
      responseType: "keyboard",
      messageType: "request_keyboard",
      params: { action },
      timeoutMs,
      perf,
      errorLabel: "Keyboard",
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
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyPressKeyResult> {
    return sendCommand<CtrlProxyPressKeyResult>(this.context, {
      idPrefix: "pressKey",
      responseType: "press_key",
      messageType: "request_press_key",
      params: { key, modifiers },
      timeoutMs,
      perf,
      errorLabel: "Press key",
    });
  }
}
