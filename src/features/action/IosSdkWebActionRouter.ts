import { ActionableError } from "../../models/ActionableError";
import type { SdkBridgeRequestOptions } from "../observe/ios/CtrlProxySdkObservation";
import type { IosSdkWebTarget } from "../observe/ios/iosSdkWebMerge";
import type { IosSdkWebAction } from "../observe/ios/sdkWebViewBridge";
import type { CtrlProxySdkWebActionResult } from "../observe/ios/types";
import type { IosSdkTapOutcome } from "./IosSdkBridgeTapRouter";

/**
 * Routes actions on DOM elements merged from an iOS SDK WKWebView bridge through the web view's
 * bounded actions (#5162).
 *
 * The action names the snapshot the element came from, so the web view rejects it when that
 * snapshot is no longer among its recent ones. XCTest stands in only when the web view bridge is
 * unavailable or the action has no web form. Every web rejection (`stale_snapshot`,
 * `element_not_actionable`, `disallowed_origin`, `web_process_unavailable`, `javascript_error`)
 * fails closed, as for the native bridge: XCTest acting at those coordinates could hit a different
 * element.
 */

/** The runner call a web action needs. */
export interface IosSdkWebActionClient {
  requestSdkWebActionForIos(
    webViewId: string,
    action: IosSdkWebAction,
    options?: SdkBridgeRequestOptions,
  ): Promise<CtrlProxySdkWebActionResult>;
}

/** Budget for one web action; the bounded script runs synchronously in the page. */
export const IOS_SDK_WEB_ACTION_TIMEOUT_MS = 5000;

function failClosed(reason: string, verb: string): never {
  throw new ActionableError(
    `The app's SDK web-view bridge rejected the ${verb} (${reason}). Re-observe and retry; ` +
      "XCTest does not stand in for this result, because the page may have changed.",
  );
}

/** Maps a web action reply to the backend that acted, a permitted XCTest fallback, or an error. */
export function iosSdkWebActionOutcome(
  reply: CtrlProxySdkWebActionResult,
  verb: string,
): IosSdkTapOutcome {
  if (reply.result?.status === "accepted") {
    return { backend: "sdk" };
  }
  if (reply.result) {
    return failClosed(reply.result.reason ?? reply.result.status, verb);
  }
  if (reply.failure === "bridge_unavailable" || reply.unsupported) {
    return { backend: "xctest", fallbackReason: "unavailable" };
  }
  // app_not_active, invalid_action, bad_reply, no_snapshot, disallowed_origin,
  // web_process_unavailable, message_too_large, or a timeout after the action may have run.
  return failClosed(reply.failure ?? reply.error ?? "no reply", verb);
}

/** The web form of a tap action, or null when it has none (a long press, a double tap). */
export function webTapAction(action: string, target: IosSdkWebTarget): IosSdkWebAction | null {
  return action === "tap"
    ? { click: { snapshotId: target.snapshotId, elementId: target.elementId } }
    : null;
}

/** Performs one web action on the element's web view and maps the reply. */
export async function performIosSdkWebAction(
  client: IosSdkWebActionClient | null,
  target: IosSdkWebTarget,
  action: IosSdkWebAction,
  { verb, signal }: { verb: string; signal?: AbortSignal },
): Promise<IosSdkTapOutcome> {
  if (!client) {
    return { backend: "xctest", fallbackReason: "unavailable" };
  }
  const reply = await client.requestSdkWebActionForIos(target.webViewId, action, {
    timeoutMs: IOS_SDK_WEB_ACTION_TIMEOUT_MS,
    signal,
  });
  return iosSdkWebActionOutcome(reply, verb);
}
