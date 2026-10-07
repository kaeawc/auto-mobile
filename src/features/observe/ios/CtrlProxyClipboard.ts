/**
 * CtrlProxy iOS Clipboard - Delegate for clipboard operations.
 *
 * This delegate handles clipboard operations (get, copy, paste, clear)
 * via the iOS CtrlProxy WebSocket API.
 */

import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { DelegateContext, CtrlProxyClipboardResult } from "./types";
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { sendCommand } from "../DeviceServiceUtils";

/**
 * Delegate class for handling clipboard operations.
 */
export class CtrlProxyClipboard {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /**
   * Request a clipboard operation.
   */
  async requestClipboard(
    action: "copy" | "paste" | "clear" | "get",
    text?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<CtrlProxyClipboardResult & { acknowledged: boolean }> {
    const params: Record<string, unknown> = { action };
    if (text !== undefined) {
      params.text = text;
    }

    // Local latch mirrors VoiceOver activation; only a completed socket write commits paste.
    let dispatched = false;
    const unconfirmed = (error: string, totalTimeMs = 0) => ({
      success: false,
      action,
      totalTimeMs,
      error,
      acknowledged: false,
    });
    try {
      const result = await sendCommand<CtrlProxyClipboardResult & { acknowledged?: boolean }>(
        this.context,
        {
          idPrefix: "clipboard",
          responseType: "clipboard",
          messageType: "request_clipboard",
          params,
          timeoutMs,
          abortSignal: signal,
          onDispatch: () => {
            dispatched = true;
            onDispatch?.();
          },
          perf,
          cancelScreenshotBackoff: false,
          notConnectedError: () => unconfirmed("Not connected"),
          unsupportedCommandError: (_messageType, error) => ({
            success: false,
            action,
            totalTimeMs: 0,
            error,
          }),
          timeoutError: (timeout) =>
            unconfirmed(`Clipboard operation timed out after ${timeout}ms`, timeout),
        },
      );
      // Runner replies acknowledge even refusals; timeout factories explicitly do not.
      return { ...result, acknowledged: result.acknowledged ?? dispatched };
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      // Structured runner refusals acknowledge the request; caller cancellation does not.
      if (dispatched && error instanceof ActionableError && error !== signal?.reason) {
        logger.warn("[CtrlProxyClipboard] Runner refused clipboard operation", error);
        return { ...unconfirmed(errorMessage(error)), acknowledged: true };
      }
      logger.warn("[CtrlProxyClipboard] Clipboard transport failed", error);
      return unconfirmed(errorMessage(error));
    } finally {
      if (!dispatched) {
        signal?.throwIfAborted();
      }
    }
  }
}
