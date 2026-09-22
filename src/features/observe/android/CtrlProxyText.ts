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

  async commitViaIme(
    text: string,
    priorImeId?: string,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<BaseResult> {
    return sendCommand<BaseResult>(this.context, {
      idPrefix: "commitText",
      responseType: "commit_text",
      messageType: "request_commit_text",
      params: { text, priorImeId },
      timeoutMs,
      perf,
      errorLabel: "Commit text",
    });
  }
}
