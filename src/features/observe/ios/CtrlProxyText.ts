/**
 * CtrlProxyText - iOS text delegate.
 *
 * Extends SharedTextDelegate with iOS-specific overrides.
 * clearText uses a dedicated `request_clear_text` command (Cmd+A, Delete)
 * instead of the Android fallback of sending empty text via `request_set_text`.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { BaseResult } from "../shared/types";
import { SharedTextDelegate } from "../shared/SharedTextDelegate";
import type { DelegateContext } from "./types";
import { sendCommand, type SendCommandOptions } from "../DeviceServiceUtils";
import type { SetTextOptions } from "../DeviceService";
import {
  resolveTextCtrlProxyTimeoutMs,
  getTextRequestDeadlineMs,
  TextIndeterminateError,
} from "../../action/textTransportTimeout";
import { combineWithAmbientAbort, getRequestContext } from "../../../utils/AbortContext";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";

export class CtrlProxyText extends SharedTextDelegate {
  constructor(context: DelegateContext) {
    super(context);
  }

  override requestSetText(text: string, options: SetTextOptions = {}): Promise<BaseResult> {
    return super.requestSetText(text, {
      ...options,
      timeoutMs: options.timeoutMs ?? resolveTextCtrlProxyTimeoutMs(text),
    });
  }

  protected override async sendTextCommand(
    options: SendCommandOptions<BaseResult>,
  ): Promise<BaseResult> {
    let dispatched = false;
    let completeDispatch: ((confirmed: boolean) => void) | undefined;
    const startMs = this.context.timer.now();
    const unconfirmed = (reason: string, totalTimeMs: number): BaseResult => ({
      success: false,
      totalTimeMs,
      // Reuse executeBoundedIosIme's retryable=false marker in SendKeys.ts
      // and InputKey.indeterminateError's dispatched-but-unconfirmed guidance.
      ...(dispatched ? { retryable: false } : {}),
      error: dispatched ? new TextIndeterminateError(reason).message : reason,
    });
    try {
      const result = await sendCommand<BaseResult>(this.context, {
        ...options,
        deadlineMs: options.deadlineMs ?? getTextRequestDeadlineMs(),
        abortSignal: combineWithAmbientAbort(options.abortSignal),
        onDispatch: (id) => {
          dispatched = true;
          completeDispatch = getRequestContext()?.textState.dispatched();
          options.onDispatch?.(id);
        },
        timeoutError: (timeout) =>
          unconfirmed(`${options.errorLabel} timed out after ${timeout}ms`, timeout),
      });
      completeDispatch?.(result.retryable !== false);
      return result;
    } catch (error) {
      completeDispatch?.(false);
      logger.warn("[CtrlProxyText] Text transport failed", error);
      return unconfirmed(errorMessage(error), this.context.timer.now() - startMs);
    }
  }

  /**
   * Insert committed text at the focused field's current caret without clearing
   * or resolving a resource id. This is the iOS half of daemon append mode.
   */
  async requestAppendText(
    text: string,
    timeoutMs: number = resolveTextCtrlProxyTimeoutMs(text),
    perf?: PerformanceTracker,
    frameContext?: string,
    options: Pick<SetTextOptions, "abortSignal" | "deadlineMs" | "onDispatch"> = {},
  ): Promise<BaseResult> {
    // Older released runners predate request_append_text, but their untargeted
    // request_set_text path already uses XCUITest typeText at the focused caret.
    // It is therefore the same non-destructive append operation for this call.
    const supportedCommands = await this.context.getSupportedCommands?.();
    if (
      supportedCommands === null ||
      (supportedCommands !== undefined && !supportedCommands.includes("request_append_text")) ||
      (supportedCommands === undefined &&
        this.context.isCommandSupported?.("request_append_text") === false)
    ) {
      return this.requestSetText(text, { timeoutMs, perf, frameContext, ...options });
    }

    const params: Record<string, unknown> = { text };
    if (frameContext !== undefined) {
      params.frameContext = frameContext;
    }
    return this.sendTextCommand({
      idPrefix: "appendText",
      responseType: "append_text",
      messageType: "request_append_text",
      params,
      timeoutMs,
      perf,
      errorLabel: "Append text",
      ...options,
    });
  }

  /**
   * iOS-specific clearText: sends `request_clear_text` which the iOS CtrlProxy
   * handles via Cmd+A + Delete for native fields. Non-native fields use up to
   * 20 bursts of 50 deletes (GesturePerformer.swift:1465-1485), with no timing
   * evidence. Preserve the 5000ms timeout until one simulator measurement.
   *
   * The base class fallback sends `requestSetText("")` which only works on
   * Android where the accessibility service interprets empty text as "clear".
   */
  override async requestClearText(
    resourceId?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    options: Pick<SetTextOptions, "abortSignal" | "deadlineMs" | "onDispatch"> = {},
  ): Promise<BaseResult> {
    const params: Record<string, unknown> = {};
    if (resourceId) {
      params.resourceId = resourceId;
    }

    return this.sendTextCommand({
      idPrefix: "clearText",
      responseType: "clear_text",
      messageType: "request_clear_text",
      params,
      timeoutMs,
      perf,
      errorLabel: "Clear text",
      ...options,
    });
  }
}
