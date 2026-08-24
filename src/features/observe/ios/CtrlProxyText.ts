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
import { sendCommand } from "../DeviceServiceUtils";

export class CtrlProxyText extends SharedTextDelegate {
  constructor(context: DelegateContext) {
    super(context);
  }

  /**
   * Insert committed text at the focused field's current caret without clearing
   * or resolving a resource id. This is the iOS half of daemon append mode.
   */
  async requestAppendText(
    text: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    frameContext?: string,
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
      return this.requestSetText(text, { timeoutMs, perf, frameContext });
    }

    const params: Record<string, unknown> = { text };
    if (frameContext !== undefined) {
      params.frameContext = frameContext;
    }
    return sendCommand<BaseResult>(this.context, {
      idPrefix: "appendText",
      responseType: "append_text",
      messageType: "request_append_text",
      params,
      timeoutMs,
      perf,
      errorLabel: "Append text",
    });
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
    perf?: PerformanceTracker,
  ): Promise<BaseResult> {
    const params: Record<string, unknown> = {};
    if (resourceId) {
      params.resourceId = resourceId;
    }

    return sendCommand<BaseResult>(this.context, {
      idPrefix: "clearText",
      responseType: "clear_text",
      messageType: "request_clear_text",
      params,
      timeoutMs,
      perf,
      errorLabel: "Clear text",
    });
  }
}
