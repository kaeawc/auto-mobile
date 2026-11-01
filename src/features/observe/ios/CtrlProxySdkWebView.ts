/**
 * CtrlProxy iOS SDK WKWebView bridge (#5162): reads an opted-in web view's latest bounded snapshot
 * and performs one bounded web action through the runner's `request_sdk_web_snapshot` and
 * `request_sdk_web_action` commands.
 */

import { sendCommand } from "../DeviceServiceUtils";
import {
  IOS_SDK_OBSERVATION_TIMEOUT_MS,
  type SdkBridgeRequestOptions,
} from "./CtrlProxySdkObservation";
import type { IosSdkWebAction } from "./sdkWebViewBridge";
import type {
  CtrlProxySdkWebActionResult,
  CtrlProxySdkWebSnapshotResult,
  DelegateContext,
} from "./types";

export interface SdkWebSnapshotRequestOptions extends SdkBridgeRequestOptions {
  /** The web view to read; omitted reads the app's first registered web view. */
  webViewId?: string;
}

function failure<T extends CtrlProxySdkWebSnapshotResult | CtrlProxySdkWebActionResult>(
  error: string,
  extra: Partial<T> = {},
): T {
  return { success: false, available: false, totalTimeMs: 0, error, ...extra } as T;
}

export async function requestSdkWebSnapshot(
  context: DelegateContext,
  options: SdkWebSnapshotRequestOptions = {},
): Promise<CtrlProxySdkWebSnapshotResult> {
  return sendCommand<CtrlProxySdkWebSnapshotResult>(context, {
    idPrefix: "sdkWebSnapshot",
    responseType: "sdk_web_snapshot_result",
    messageType: "request_sdk_web_snapshot",
    ...(options.webViewId === undefined ? {} : { params: { webViewId: options.webViewId } }),
    timeoutMs: options.timeoutMs ?? IOS_SDK_OBSERVATION_TIMEOUT_MS,
    abortSignal: options.signal,
    cancelScreenshotBackoff: false,
    notConnectedError: () => failure("Not connected to CtrlProxy"),
    unsupportedCommandError: (_type, error) => failure(error, { unsupported: true }),
    timeoutError: () => failure("Timeout waiting for sdk_web_snapshot_result", { available: true }),
  });
}

export async function requestSdkWebAction(
  context: DelegateContext,
  webViewId: string,
  action: IosSdkWebAction,
  options: SdkBridgeRequestOptions = {},
): Promise<CtrlProxySdkWebActionResult> {
  return sendCommand<CtrlProxySdkWebActionResult>(context, {
    idPrefix: "sdkWebAction",
    responseType: "sdk_web_action_result",
    messageType: "request_sdk_web_action",
    params: { webViewId, actionJson: JSON.stringify(action) },
    timeoutMs: options.timeoutMs ?? IOS_SDK_OBSERVATION_TIMEOUT_MS,
    abortSignal: options.signal,
    cancelScreenshotBackoff: false,
    notConnectedError: () => failure("Not connected to CtrlProxy"),
    unsupportedCommandError: (_type, error) => failure(error, { unsupported: true }),
    // A timeout may follow delivery: the action may have run, so it must not read as "no bridge".
    timeoutError: () => failure("Timeout waiting for sdk_web_action_result", { available: true }),
  });
}
