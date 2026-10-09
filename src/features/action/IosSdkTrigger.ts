import type { BootedDevice } from "../../models";
import { delayForAttempt, sequenceBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
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

/** Total time to wait for the app's in-app SDK server to come up after launch (#10873). */
export const IOS_SDK_ROUTE_READY_BUDGET_MS = 5_000;

const DEFAULT_ROUTE_READY_BACKOFF: BackoffPolicy = sequenceBackoff([100, 200, 400, 800]);

export interface SdkRouteReadinessOptions {
  timer?: Timer;
  budgetMs?: number;
  backoff?: BackoffPolicy;
}

/**
 * Wrap a sender so a trigger that finds no reachable in-app SDK route is retried for a
 * bounded time. Right after `launchApp` the app's SDK server is not listening yet
 * (#10873); the route is expected to appear within seconds. Unsupported runners and
 * SDK-level errors are final and never retried.
 */
export function withSdkRouteReadiness(
  sender: IosSdkTriggerSender,
  options: SdkRouteReadinessOptions = {},
): IosSdkTriggerSender {
  const timer = options.timer ?? defaultTimer;
  const budgetMs = options.budgetMs ?? IOS_SDK_ROUTE_READY_BUDGET_MS;
  const backoff = options.backoff ?? DEFAULT_ROUTE_READY_BACKOFF;
  return {
    async requestSdkTrigger(request) {
      const deadline = timer.now() + budgetMs;
      let attempt = 1;
      for (;;) {
        const result = await sender.requestSdkTrigger(request);
        if (result.available || result.unsupported) {
          return result;
        }
        const remaining = deadline - timer.now();
        if (remaining <= 0) {
          return result;
        }
        await timer.sleep(Math.min(delayForAttempt(backoff, attempt), remaining));
        attempt += 1;
      }
    },
  };
}

export const defaultIosSdkTriggerSenderFactory: IosSdkTriggerSenderFactory = (device) =>
  withSdkRouteReadiness(IOSCtrlProxyClient.getInstance(device));

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
      `No in-app SDK trigger route was reachable${detail}. ` +
      `The SDK server may still be starting right after launchApp, and a pending ` +
      `first-run notification-permission prompt can also block the route; dismiss it and retry.`
    );
  }
  const describeSdkError = result.sdkError ? SDK_ERROR_MESSAGES[result.sdkError] : undefined;
  if (describeSdkError) {
    return describeSdkError(result, request, feature);
  }
  return `${feature} on iOS failed${detail || " in the app's AutoMobile SDK"}.`;
}
