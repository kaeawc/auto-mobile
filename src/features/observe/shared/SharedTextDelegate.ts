/**
 * SharedTextDelegate - Unified delegate for text input operations.
 *
 * Handles setText, clearText, IME actions, and selectAll for both Android and iOS.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { DelegateContext, BaseResult, ActionTimingResult } from "./types";
import { createMessage } from "../DeviceServiceUtils";
import { logger } from "../../../utils/logger";

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
    const startMs = Date.now();
    this.context.cancelScreenshotBackoff();

    const connected = await (perf
      ? perf.track("ensureConnected", () => this.context.ensureConnected(perf))
      : this.context.ensureConnected(perf));
    if (!connected) {
      logger.warn(`[SharedTextDelegate] requestSetText aborted: not connected (resourceId=${resourceId ?? "nil"})`);
      return { success: false, totalTimeMs: 0, error: "Not connected" };
    }

    const requestId = this.context.requestManager.generateId("setText");
    logger.debug(`[SharedTextDelegate] requestSetText send requestId=${requestId} resourceId=${resourceId ?? "nil"} textLength=${text.length} dismissKeyboard=${dismissKeyboard} timeoutMs=${timeoutMs}`);

    const promise = this.context.requestManager.register<BaseResult>(
      requestId,
      "set_text",
      timeoutMs,
      (_id, _type, timeout) => ({
        success: false,
        totalTimeMs: timeout,
        error: `Set text timed out after ${timeout}ms`
      })
    );

    const params: Record<string, unknown> = { text };
    if (resourceId) {
      params.resourceId = resourceId;
    }
    if (dismissKeyboard) {
      params.dismissKeyboard = true;
    }

    const msg = createMessage("request_set_text", requestId, params);
    this.context.getWebSocket()?.send(msg);
    const result = await (perf
      ? perf.track("setText.awaitResponse", () => promise)
      : promise);
    logger.debug(`[SharedTextDelegate] requestSetText done requestId=${requestId} success=${result.success} totalMs=${Date.now() - startMs}${result.error ? ` error=${result.error}` : ""}`);
    return result;
  }

  async requestClearText(
    resourceId?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<BaseResult> {
    return this.requestSetText("", resourceId, timeoutMs, perf);
  }

  async requestImeAction(
    action: "done" | "next" | "search" | "send" | "go" | "previous",
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<ActionTimingResult> {
    const startMs = Date.now();
    this.context.cancelScreenshotBackoff();

    const connected = await (perf
      ? perf.track("ensureConnected", () => this.context.ensureConnected(perf))
      : this.context.ensureConnected(perf));
    if (!connected) {
      logger.warn(`[SharedTextDelegate] requestImeAction aborted: not connected (action=${action})`);
      return { success: false, action, totalTimeMs: 0, error: "Not connected" };
    }

    const requestId = this.context.requestManager.generateId("imeAction");
    logger.debug(`[SharedTextDelegate] requestImeAction send requestId=${requestId} action=${action} timeoutMs=${timeoutMs}`);

    const promise = this.context.requestManager.register<ActionTimingResult>(
      requestId,
      "ime_action",
      timeoutMs,
      (_id, _type, timeout) => ({
        success: false,
        action,
        totalTimeMs: timeout,
        error: `IME action timed out after ${timeout}ms`
      })
    );

    const msg = createMessage("request_ime_action", requestId, { action });
    this.context.getWebSocket()?.send(msg);
    const result = await (perf
      ? perf.track("imeAction.awaitResponse", () => promise)
      : promise);
    logger.debug(`[SharedTextDelegate] requestImeAction done requestId=${requestId} action=${action} success=${result.success} totalMs=${Date.now() - startMs}${result.error ? ` error=${result.error}` : ""}`);
    return result;
  }

  async requestSelectAll(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker
  ): Promise<BaseResult> {
    const startMs = Date.now();
    this.context.cancelScreenshotBackoff();

    const connected = await (perf
      ? perf.track("ensureConnected", () => this.context.ensureConnected(perf))
      : this.context.ensureConnected(perf));
    if (!connected) {
      logger.warn(`[SharedTextDelegate] requestSelectAll aborted: not connected`);
      return { success: false, totalTimeMs: 0, error: "Not connected" };
    }

    const requestId = this.context.requestManager.generateId("selectAll");
    logger.debug(`[SharedTextDelegate] requestSelectAll send requestId=${requestId} timeoutMs=${timeoutMs}`);

    const promise = this.context.requestManager.register<BaseResult>(
      requestId,
      "select_all",
      timeoutMs,
      (_id, _type, timeout) => ({
        success: false,
        totalTimeMs: timeout,
        error: `Select all timed out after ${timeout}ms`
      })
    );

    const msg = createMessage("request_select_all", requestId);
    this.context.getWebSocket()?.send(msg);
    const result = await (perf
      ? perf.track("selectAll.awaitResponse", () => promise)
      : promise);
    logger.debug(`[SharedTextDelegate] requestSelectAll done requestId=${requestId} success=${result.success} totalMs=${Date.now() - startMs}${result.error ? ` error=${result.error}` : ""}`);
    return result;
  }
}
