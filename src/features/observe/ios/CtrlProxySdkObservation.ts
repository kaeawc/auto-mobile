/**
 * CtrlProxy iOS SDK observation bridge (#5159): reads the foreground app's bridge snapshot and
 * performs one bridge action through the runner's `request_sdk_observation` and
 * `request_sdk_action` commands.
 */

import { sendCommand } from "../DeviceServiceUtils";
import type { IosSdkAction } from "./sdkObservationBridge";
import type {
  CtrlProxySdkActionResult,
  CtrlProxySdkObservationResult,
  DelegateContext,
} from "./types";

/** Default budget: the runner's own request to the SDK times out after 2 seconds. */
export const IOS_SDK_OBSERVATION_TIMEOUT_MS = 5000;

export interface SdkBridgeRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function failure<T extends CtrlProxySdkObservationResult | CtrlProxySdkActionResult>(
  error: string,
  extra: Partial<T> = {},
): T {
  return { success: false, available: false, totalTimeMs: 0, error, ...extra } as T;
}

export async function requestSdkObservation(
  context: DelegateContext,
  options: SdkBridgeRequestOptions = {},
): Promise<CtrlProxySdkObservationResult> {
  return sendCommand<CtrlProxySdkObservationResult>(context, {
    idPrefix: "sdkObservation",
    responseType: "sdk_observation_result",
    messageType: "request_sdk_observation",
    timeoutMs: options.timeoutMs ?? IOS_SDK_OBSERVATION_TIMEOUT_MS,
    abortSignal: options.signal,
    cancelScreenshotBackoff: false,
    notConnectedError: () => failure("Not connected to CtrlProxy"),
    unsupportedCommandError: (_type, error) => failure(error, { unsupported: true }),
    timeoutError: () => failure("Timeout waiting for sdk_observation_result", { available: true }),
  });
}

export async function requestSdkAction(
  context: DelegateContext,
  action: IosSdkAction,
  options: SdkBridgeRequestOptions = {},
): Promise<CtrlProxySdkActionResult> {
  return sendCommand<CtrlProxySdkActionResult>(context, {
    idPrefix: "sdkAction",
    responseType: "sdk_action_result",
    messageType: "request_sdk_action",
    params: { actionJson: JSON.stringify(action), timeoutMs: options.timeoutMs },
    timeoutMs: options.timeoutMs ?? IOS_SDK_OBSERVATION_TIMEOUT_MS,
    abortSignal: options.signal,
    cancelScreenshotBackoff: false,
    notConnectedError: () => failure("Not connected to CtrlProxy"),
    unsupportedCommandError: (_type, error) => failure(error, { unsupported: true }),
    // A timeout may follow delivery: the action may have run, so it must not read as "no bridge".
    timeoutError: () => failure("Timeout waiting for sdk_action_result", { available: true }),
  });
}
