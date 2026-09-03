/**
 * CtrlProxyText - Android text delegate.
 *
 * Thin wrapper over SharedTextDelegate.
 */

import { SharedTextDelegate } from "../shared/SharedTextDelegate";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { BaseResult } from "../shared/types";
import type { DelegateContext } from "./types";
import { sendCommand } from "../DeviceServiceUtils";

export class CtrlProxyText extends SharedTextDelegate {
  constructor(context: DelegateContext) {
    super(context);
  }

  async requestInsertText(
    text: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<BaseResult> {
    return sendCommand<BaseResult>(this.context, {
      idPrefix: "insertText",
      responseType: "insert_text",
      messageType: "request_insert_text",
      params: { text },
      timeoutMs,
      perf,
      errorLabel: "Insert text",
    });
  }
}
