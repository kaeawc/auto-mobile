/**
 * CtrlProxy iOSScreenshot - Delegate for screenshot operations.
 *
 * This delegate handles screenshot capture via the iOS CtrlProxy iOS WebSocket API.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { DelegateContext, CtrlProxyScreenshotResult } from "./types";
import { sendCommand } from "../DeviceServiceUtils";

/**
 * Delegate class for handling screenshot operations.
 */
export class CtrlProxyScreenshot {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /**
   * Request a screenshot from the CtrlProxy iOS.
   */
  async requestScreenshot(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyScreenshotResult> {
    return sendCommand<CtrlProxyScreenshotResult>(this.context, {
      idPrefix: "screenshot",
      responseType: "screenshot",
      messageType: "request_screenshot",
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      notConnectedError: () => ({ success: false, error: "Not connected" }),
      timeoutError: (timeout) => ({
        success: false,
        error: `Screenshot timed out after ${timeout}ms`,
      }),
    });
  }
}
