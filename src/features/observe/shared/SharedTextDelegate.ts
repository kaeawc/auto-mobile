/**
 * SharedTextDelegate - Unified delegate for text input operations.
 *
 * Handles setText, clearText, IME actions, and selectAll for both Android and iOS.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { ImeAction } from "../../../models";
import type { SetTextOptions } from "../DeviceService";
import type { DelegateContext, BaseResult, ActionTimingResult } from "./types";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { sendCommand, type SendCommandOptions } from "../DeviceServiceUtils";

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

    return this.sendTextCommand({
      idPrefix: "setText",
      responseType: "set_text",
      messageType: "request_set_text",
      params,
      timeoutMs,
      perf,
      errorLabel: "Set text",
      abortSignal: options.abortSignal,
      deadlineMs: options.deadlineMs,
      onDispatch: options.onDispatch,
    });
  }

  /** iOS specializes unconfirmed mutations; Android retains its existing result contract. */
  protected sendTextCommand(options: SendCommandOptions<BaseResult>): Promise<BaseResult> {
    return sendCommand<BaseResult>(this.context, options);
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
    let dispatched = false;
    const startMs = this.context.timer.now();
    const unconfirmed = (reason: string, totalTimeMs: number): ActionTimingResult => ({
      success: false,
      action,
      totalTimeMs,
      ...(dispatched ? { retryable: false } : {}),
      error: dispatched
        ? `IME action '${action}' outcome is indeterminate: the request was dispatched but no result was confirmed (${reason}). Do not retry automatically. Observe before retrying.`
        : reason,
    });
    try {
      return await sendCommand<ActionTimingResult>(this.context, {
        idPrefix: "imeAction",
        responseType: "ime_action",
        messageType: "request_ime_action",
        params: { action },
        timeoutMs,
        perf,
        abortSignal,
        onDispatch: () => {
          dispatched = true;
          onDispatch?.();
        },
        notConnectedError: () => ({
          success: false,
          action,
          totalTimeMs: 0,
          error: "Not connected",
        }),
        unsupportedCommandError: (_messageType, error) => ({
          success: false,
          action,
          totalTimeMs: 0,
          error,
        }),
        timeoutError: (timeout) => unconfirmed(`IME action timed out after ${timeout}ms`, timeout),
      });
    } catch (error) {
      logger.warn("[SharedTextDelegate] IME action transport failed", error);
      return unconfirmed(errorMessage(error), this.context.timer.now() - startMs);
    }
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
