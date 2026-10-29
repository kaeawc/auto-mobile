import type { BootedDevice } from "../../models";
import { serverConfig } from "../../utils/ServerConfig";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import type { IosSdkBridgeClient } from "../observe/ios/IosSdkBridgeReader";
import type { IosSdkBridgeTarget } from "../observe/ios/iosSdkObservationMerge";
import type { IosSdkAction } from "../observe/ios/sdkObservationBridge";
import { iosSdkBridgeActionOutcome, type IosSdkTapOutcome } from "./IosSdkBridgeTapRouter";

/**
 * Routes sendKeys text entry and clear on a field merged from the iOS SDK observation bridge
 * through the bridge's `insertText` / `clearText` actions (#5159).
 *
 * The rules are the tap router's: XCTest stands in only when the bridge is unavailable or does not
 * support the action, and every other rejection fails closed. An accepted action moves the
 * bridge's current observation, so the router hands back the next capture identity for the
 * caller's following action on the same field.
 */

export type IosSdkTextAction = "insertText" | "clearText";

export interface IosSdkBridgeTextRequest {
  action: IosSdkTextAction;
  target: IosSdkBridgeTarget;
  /** Required for `insertText`. */
  text?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface IosSdkBridgeTextRouter {
  /** Returns null when routing is off, so the caller uses XCTest and reports nothing extra. */
  perform(request: IosSdkBridgeTextRequest): Promise<IosSdkTapOutcome | null>;
}

/** Budget for one bridge text action when the caller has no text-specific budget. */
export const IOS_SDK_BRIDGE_TEXT_TIMEOUT_MS = 5000;

function textAction(request: IosSdkBridgeTextRequest): IosSdkAction {
  const { elementId, observationIdentity } = request.target;
  return request.action === "insertText"
    ? { insertText: { observationIdentity, elementId, text: request.text ?? "" } }
    : { clearText: { observationIdentity, elementId } };
}

export interface IosSdkBridgeTextRouterOptions {
  client: () => Pick<IosSdkBridgeClient, "requestSdkActionForIos"> | null;
  enabled?: () => boolean;
}

export function createIosSdkBridgeTextRouter(
  options: IosSdkBridgeTextRouterOptions,
): IosSdkBridgeTextRouter {
  const enabled = options.enabled ?? (() => serverConfig.isIosSdkObservationBridgeEnabled());
  return {
    async perform(request) {
      if (!enabled()) {
        return null;
      }
      const client = options.client();
      if (!client) {
        return { backend: "xctest", fallbackReason: "unavailable" };
      }
      const reply = await client.requestSdkActionForIos(textAction(request), {
        timeoutMs: request.timeoutMs ?? IOS_SDK_BRIDGE_TEXT_TIMEOUT_MS,
        signal: request.signal,
      });
      return iosSdkBridgeActionOutcome(
        reply,
        request.action === "insertText" ? "text entry" : "clear",
      );
    },
  };
}

/** The production router: the device's existing runner client, gated by the routing flag. */
export function deviceIosSdkBridgeTextRouter(
  device: Pick<BootedDevice, "deviceId">,
): IosSdkBridgeTextRouter {
  return createIosSdkBridgeTextRouter({
    client: () => IOSCtrlProxyClient.getExistingInstance(device.deviceId),
  });
}
