/**
 * CtrlProxy iOS SDK trigger - relays a named trigger to a module in the foreground
 * app's in-app SDK (`POST /trigger`, #1580) through the runner's
 * `request_sdk_trigger` command.
 */

import { sendCommand } from "../DeviceServiceUtils";
import type { DelegateContext, CtrlProxySdkTriggerResult } from "./types";

/** Default budget: the runner's own request to the SDK times out after 2 seconds. */
export const IOS_SDK_TRIGGER_TIMEOUT_MS = 5000;

export interface SdkTriggerRequest {
  /** SDK module name, e.g. `callkit`, `messages`, `biometrics`. */
  module: string;
  trigger: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function requestSdkTrigger(
  context: DelegateContext,
  request: SdkTriggerRequest,
): Promise<CtrlProxySdkTriggerResult> {
  const failure = (
    error: string,
    extra: Partial<CtrlProxySdkTriggerResult> = {},
  ): CtrlProxySdkTriggerResult => ({
    success: false,
    available: false,
    totalTimeMs: 0,
    error,
    ...extra,
  });
  return sendCommand<CtrlProxySdkTriggerResult>(context, {
    idPrefix: "sdkTrigger",
    responseType: "sdk_trigger_result",
    messageType: "request_sdk_trigger",
    params: {
      module: request.module,
      trigger: request.trigger,
      ...(request.payload ? { payloadJson: JSON.stringify(request.payload) } : {}),
    },
    timeoutMs: request.timeoutMs ?? IOS_SDK_TRIGGER_TIMEOUT_MS,
    abortSignal: request.signal,
    cancelScreenshotBackoff: false,
    notConnectedError: () => failure("Not connected to CtrlProxy"),
    unsupportedCommandError: (_type, error) => failure(error, { unsupported: true }),
    // A timeout may follow delivery, so it must not claim the SDK is absent.
    timeoutError: () => failure("Timeout waiting for sdk_trigger_result", { available: true }),
  });
}
