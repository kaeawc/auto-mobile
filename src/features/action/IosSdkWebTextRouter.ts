import type { BootedDevice } from "../../models";
import { serverConfig } from "../../utils/ServerConfig";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import type { IosSdkWebTarget } from "../observe/ios/iosSdkWebMerge";
import type { IosSdkWebAction } from "../observe/ios/sdkWebViewBridge";
import type { IosSdkTapOutcome } from "./IosSdkBridgeTapRouter";
import { performIosSdkWebAction, type IosSdkWebActionClient } from "./IosSdkWebActionRouter";

/**
 * Routes sendKeys on a DOM element merged from an opted-in WKWebView through the web view's
 * bounded actions (#5162): text entry is `setValue`, clear is `clear`, and IME `done` is `submit`.
 *
 * The rules are the tap router's: XCTest stands in only when the bridge is unavailable, and every
 * rejection (a stale snapshot, an unactionable element, a disallowed origin) fails closed.
 */

export type IosSdkWebTextAction = "setValue" | "clear" | "submit";

export interface IosSdkWebTextRequest {
  action: IosSdkWebTextAction;
  target: IosSdkWebTarget;
  /** Required for `setValue`. */
  text?: string;
  signal?: AbortSignal;
}

export interface IosSdkWebTextRouter {
  /** Returns null when routing is off, so the caller uses XCTest and reports nothing extra. */
  perform(request: IosSdkWebTextRequest): Promise<IosSdkTapOutcome | null>;
}

const VERBS: Record<IosSdkWebTextAction, string> = {
  setValue: "text entry",
  clear: "clear",
  submit: "submit",
};

function webTextAction(request: IosSdkWebTextRequest): IosSdkWebAction {
  const { snapshotId, elementId } = request.target;
  switch (request.action) {
    case "setValue":
      return { setValue: { snapshotId, elementId, text: request.text ?? "" } };
    case "clear":
      return { clear: { snapshotId, elementId } };
    case "submit":
      return { submit: { snapshotId, elementId } };
  }
}

export interface IosSdkWebTextRouterOptions {
  client: () => IosSdkWebActionClient | null;
  enabled?: () => boolean;
}

export function createIosSdkWebTextRouter(
  options: IosSdkWebTextRouterOptions,
): IosSdkWebTextRouter {
  const enabled = options.enabled ?? (() => serverConfig.isIosSdkObservationBridgeEnabled());
  return {
    async perform(request) {
      if (!enabled()) {
        return null;
      }
      return performIosSdkWebAction(
        options.client(),
        request.target,
        webTextAction(request),
        VERBS[request.action],
        request.signal,
      );
    },
  };
}

/** The production router: the device's existing runner client, gated by the routing flag. */
export function deviceIosSdkWebTextRouter(
  device: Pick<BootedDevice, "deviceId">,
): IosSdkWebTextRouter {
  return createIosSdkWebTextRouter({
    client: () => IOSCtrlProxyClient.getExistingInstance(device.deviceId),
  });
}
