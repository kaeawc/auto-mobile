import type { BootedDevice } from "../../models";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import type { SdkTriggerRequest } from "../observe/ios/CtrlProxySdkTrigger";
import type { CtrlProxySdkTriggerResult } from "../observe/ios/types";

/**
 * Narrow seam over the iOS runner's `request_sdk_trigger` command, which relays a
 * named trigger to a module in the foreground app's in-app SDK (`POST /trigger`, #1580).
 */
export interface IosSdkTriggerSender {
  requestSdkTrigger(request: SdkTriggerRequest): Promise<CtrlProxySdkTriggerResult>;
}

export type IosSdkTriggerSenderFactory = (device: BootedDevice) => IosSdkTriggerSender;

export const defaultIosSdkTriggerSenderFactory: IosSdkTriggerSenderFactory = (device) =>
  IOSCtrlProxyClient.getInstance(device);

type TriggerTarget = Pick<SdkTriggerRequest, "module" | "trigger">;

function listOrNone(values: string[] | undefined): string {
  return (values ?? []).join(", ") || "none";
}

/** Messages for the SDK's structured `POST /trigger` errors, keyed by `sdkError`. */
const SDK_ERROR_MESSAGES: Record<
  string,
  (result: CtrlProxySdkTriggerResult, request: TriggerTarget, feature: string) => string
> = {
  module_not_registered: (result, request, feature) =>
    `${feature} on iOS: the app's AutoMobile SDK has no '${request.module}' trigger module ` +
    `(registered: ${listOrNone(result.registeredModules)}). Update the AutoMobile SDK embedded in the app.`,
  unknown_trigger: (result, request, feature) =>
    `${feature} on iOS: the app's AutoMobile SDK module '${request.module}' does not support ` +
    `'${request.trigger}' (supported: ${listOrNone(result.supportedTriggers)}). ` +
    `Update the AutoMobile SDK embedded in the app.`,
  invalid_payload: (result, _request, feature) =>
    `${feature} on iOS failed in the app's AutoMobile SDK: ${result.reason ?? "invalid_payload"}.`,
  trigger_failed: (result, _request, feature) =>
    `${feature} on iOS failed in the app's AutoMobile SDK: ${result.reason ?? "trigger_failed"}.`,
};

/**
 * Explain a failed SDK trigger so the caller can act on it: a missing SDK, an SDK
 * too old to know the module or trigger, or the module's own rejection reason.
 */
export function describeIosSdkTriggerFailure(
  result: CtrlProxySdkTriggerResult,
  request: TriggerTarget,
  feature: string,
): string {
  const detail = result.error ? ` (${result.error})` : "";
  if (result.unsupported) {
    return (
      `${feature} on iOS needs an AutoMobile iOS runner that supports request_sdk_trigger; ` +
      `restart the daemon so it installs the current runner${detail}.`
    );
  }
  if (!result.available) {
    return (
      `${feature} on iOS requires the app under test to embed the AutoMobile iOS SDK ` +
      `(a DEBUG build with AutoMobileSDK started) and to be in the foreground. ` +
      `No in-app SDK trigger route was reachable${detail}.`
    );
  }
  const describeSdkError = result.sdkError ? SDK_ERROR_MESSAGES[result.sdkError] : undefined;
  if (describeSdkError) {
    return describeSdkError(result, request, feature);
  }
  return `${feature} on iOS failed${detail || " in the app's AutoMobile SDK"}.`;
}
