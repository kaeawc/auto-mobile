/**
 * CtrlProxy iOS Clipboard - Delegate for clipboard operations.
 *
 * This delegate handles clipboard operations (get, copy, paste, clear)
 * via the iOS CtrlProxy WebSocket API.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { DelegateContext, CtrlProxyClipboardResult } from "./types";
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
  ): Promise<CtrlProxyClipboardResult> {
    const params: Record<string, unknown> = { action };
    if (text !== undefined) {
      params.text = text;
    }

    return sendCommand<CtrlProxyClipboardResult>(this.context, {
      idPrefix: "clipboard",
      responseType: "clipboard",
      messageType: "request_clipboard",
      params,
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
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
        error: `Clipboard operation timed out after ${timeout}ms`,
      }),
    });
  }
}
