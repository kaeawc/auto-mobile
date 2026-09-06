/**
 * SharedTextDelegate - Unified delegate for text input operations.
 *
 * Handles setText, clearText, IME actions, and selectAll for both Android and iOS.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { ImeAction } from "../../../models";
import type { SetTextOptions } from "../DeviceService";
import type { DelegateContext, BaseResult, ActionTimingResult } from "./types";
import { sendCommand } from "../DeviceServiceUtils";

export class SharedTextDelegate {
  protected readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  async requestSetText(text: string, options: SetTextOptions = {}): Promise<BaseResult> {
    const { resourceId, timeoutMs = 5000, perf, dismissKeyboard = false, frameContext } = options;
    const params: Record<string, unknown> = { text };
    if (resourceId) {
      params.resourceId = resourceId;
    }
    if (dismissKeyboard) {
      params.dismissKeyboard = true;
    }
    if (frameContext !== undefined) {
      params.frameContext = frameContext;
    }

    return sendCommand<BaseResult>(this.context, {
      idPrefix: "setText",
      responseType: "set_text",
      messageType: "request_set_text",
      params,
      timeoutMs,
      perf,
      errorLabel: "Set text",
    });
  }

  async requestClearText(
    resourceId?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<BaseResult> {
    return this.requestSetText("", { resourceId, timeoutMs, perf });
  }

  async requestImeAction(
    action: ImeAction,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    abortSignal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<ActionTimingResult> {
    return sendCommand<ActionTimingResult>(this.context, {
      idPrefix: "imeAction",
      responseType: "ime_action",
      messageType: "request_ime_action",
      params: { action },
      timeoutMs,
      perf,
      abortSignal,
      onDispatch,
      notConnectedError: () => ({ success: false, action, totalTimeMs: 0, error: "Not connected" }),
      unsupportedCommandError: (_messageType, error) => ({
        success: false,
        action,
        totalTimeMs: 0,
        error,
      }),
      timeoutError: (timeout) => ({
        success: false,
        action,
        totalTimeMs: timeout,
        error: `IME action timed out after ${timeout}ms`,
      }),
    });
  }

  async requestSelectAll(timeoutMs: number = 5000, perf?: PerformanceTracker): Promise<BaseResult> {
    return sendCommand<BaseResult>(this.context, {
      idPrefix: "selectAll",
      responseType: "select_all",
      messageType: "request_select_all",
      timeoutMs,
      perf,
      errorLabel: "Select all",
    });
  }
}
