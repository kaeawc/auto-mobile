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
import { createMessage } from "../DeviceServiceUtils";
import { logger } from "../../../utils/logger";

export class CtrlProxyText extends SharedTextDelegate {
  constructor(context: DelegateContext) {
    super(context);
  }

  /**
   * iOS-specific clearText: sends `request_clear_text` which the iOS CtrlProxy
   * handles via Cmd+A (select all) + Delete. This is O(1) regardless of text
   * length and works with any content including emoji/Unicode.
   *
   * The base class fallback sends `requestSetText("")` which only works on
   * Android where the accessibility service interprets empty text as "clear".
   */
  override async requestClearText(
    resourceId?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<BaseResult> {
    const startMs = Date.now();
    this.context.cancelScreenshotBackoff();

    const connected = await (perf
      ? perf.track("ensureConnected", () => this.context.ensureConnected(perf))
      : this.context.ensureConnected(perf));
    if (!connected) {
      logger.warn(`[CtrlProxyText] requestClearText aborted: not connected (resourceId=${resourceId ?? "nil"})`);
      return { success: false, totalTimeMs: 0, error: "Not connected" };
    }

    const requestId = this.context.requestManager.generateId("clearText");
    logger.debug(`[CtrlProxyText] requestClearText send requestId=${requestId} resourceId=${resourceId ?? "nil"} timeoutMs=${timeoutMs}`);

    const promise = this.context.requestManager.register<BaseResult>(
      requestId,
      "clear_text",
      timeoutMs,
      (_id, _type, timeout) => ({
        success: false,
        totalTimeMs: timeout,
        error: `Clear text timed out after ${timeout}ms`
      })
    );

    const params: Record<string, unknown> = {};
    if (resourceId) {
      params.resourceId = resourceId;
    }

    const msg = createMessage("request_clear_text", requestId, params);
    this.context.getWebSocket()?.send(msg);
    const result = await (perf
      ? perf.track("clearText.awaitResponse", () => promise)
      : promise);
    logger.debug(`[CtrlProxyText] requestClearText done requestId=${requestId} success=${result.success} totalMs=${Date.now() - startMs}${result.error ? ` error=${result.error}` : ""}`);
    return result;
  }
}
