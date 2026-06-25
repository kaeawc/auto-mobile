/**
 * SharedTextDelegate - Unified delegate for text input operations.
 *
 * Handles setText, clearText, IME actions, and selectAll for both Android and iOS.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { ImeAction } from "../../../models";
import type { DelegateContext, BaseResult, ActionTimingResult } from "./types";
import { sendCommand } from "../DeviceServiceUtils";

export class SharedTextDelegate {
  protected readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /**
   * @param dismissKeyboard Android-only. Suppresses the soft keyboard via
   *   SHOW_MODE_HIDDEN after setText. Ignored on iOS (no handler on Swift side).
   */
  async requestSetText(
    text: string,
    resourceId?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    dismissKeyboard: boolean = false
  ): Promise<BaseResult> {
    const params: Record<string, unknown> = { text };
    if (resourceId) {
      params.resourceId = resourceId;
    }
    if (dismissKeyboard) {
      params.dismissKeyboard = true;
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
    perf?: PerformanceTracker
  ): Promise<BaseResult> {
    return this.requestSetText("", resourceId, timeoutMs, perf);
  }

  async requestImeAction(
    action: ImeAction,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<ActionTimingResult> {
    return sendCommand<ActionTimingResult>(this.context, {
      idPrefix: "imeAction",
      responseType: "ime_action",
      messageType: "request_ime_action",
      params: { action },
      timeoutMs,
      perf,
      notConnectedError: () => ({ success: false, action, totalTimeMs: 0, error: "Not connected" }),
      timeoutError: timeout => ({
        success: false,
        action,
        totalTimeMs: timeout,
        error: `IME action timed out after ${timeout}ms`,
      }),
    });
  }

  async requestSelectAll(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<BaseResult> {
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
