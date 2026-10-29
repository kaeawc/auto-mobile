import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models";
import type { ObservationFallbackReason } from "../../models/ObserveResult";
import { serverConfig } from "../../utils/ServerConfig";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import type { IosSdkBridgeClient } from "../observe/ios/IosSdkBridgeReader";
import { iosSdkBridgeTarget } from "../observe/ios/iosSdkObservationMerge";
import type { IosSdkAction } from "../observe/ios/sdkObservationBridge";
import type { CtrlProxySdkActionResult } from "../observe/ios/types";

/**
 * Routes `tapOn` on a node merged from the iOS SDK observation bridge through the bridge (#5159).
 *
 * The action names the observation the node came from, so the bridge rejects it when that
 * observation is stale. XCTest stands in only when the bridge is unavailable or does not support
 * the action; a stale observation, an unknown or unactionable element, an action already in
 * flight, an overloaded queue or a cancelled action fails closed, because tapping whatever XCTest
 * now finds at those coordinates could act on a different element.
 */

/**
 * - `sdk`: the bridge performed the tap.
 * - `xctest`: the caller runs the XCTest tap; `fallbackReason` says why.
 * - `null` (from {@link IosSdkBridgeTapper.tap}): the element is not a bridge node or routing is
 *   off; the caller taps with XCTest and reports nothing extra.
 */
export type IosSdkTapOutcome =
  | { backend: "sdk"; nextObservationIdentity?: number }
  | { backend: "xctest"; fallbackReason: ObservationFallbackReason };

export interface IosSdkBridgeTapRequest {
  action: string;
  element: Record<string, unknown>;
  longPressDurationMs?: number;
  signal?: AbortSignal;
}

export interface IosSdkBridgeTapper {
  tap(request: IosSdkBridgeTapRequest): Promise<IosSdkTapOutcome | null>;
}

/** Budget for one bridge tap; the bridge recaptures after an accepted action. */
export const IOS_SDK_BRIDGE_TAP_TIMEOUT_MS = 5000;

/** Bridge results that mean "XCTest may try instead". Everything else fails closed. */
const UNSUPPORTED_REASONS: ReadonlySet<string> = new Set(["unsupported_action"]);

function bridgeAction(
  request: IosSdkBridgeTapRequest,
  elementId: string,
  observationIdentity: number,
): IosSdkAction | null {
  switch (request.action) {
    case "tap":
      return { tap: { observationIdentity, elementId } };
    case "longPress":
      return {
        longPress: {
          observationIdentity,
          elementId,
          durationMs: Math.max(0, Math.round(request.longPressDurationMs ?? 500)),
        },
      };
    default:
      return null;
  }
}

function failClosed(reason: string, verb: string): never {
  throw new ActionableError(
    `The app's SDK observation bridge rejected the ${verb} (${reason}). Re-observe and retry; ` +
      "XCTest does not stand in for this result, because the element may have changed.",
  );
}

/**
 * Maps a bridge action reply to the backend that acted, a permitted XCTest fallback, or a
 * fail-closed error naming `verb` (for example "tap" or "text entry").
 */
export function iosSdkBridgeActionOutcome(
  reply: CtrlProxySdkActionResult,
  verb: string,
): IosSdkTapOutcome {
  if (reply.result?.status === "accepted") {
    return { backend: "sdk", nextObservationIdentity: reply.result.nextObservationIdentity };
  }
  if (reply.result) {
    const reason = reply.result.reason ?? reply.result.status;
    return UNSUPPORTED_REASONS.has(reason)
      ? { backend: "xctest", fallbackReason: "unsupported" }
      : failClosed(reason, verb);
  }
  if (reply.failure === "bridge_unavailable" || reply.unsupported) {
    return { backend: "xctest", fallbackReason: "unavailable" };
  }
  // app_not_active, invalid_action, bad_reply, or a timeout after the action may have run.
  return failClosed(reply.failure ?? reply.error ?? "no reply", verb);
}

export interface IosSdkBridgeTapperOptions {
  client: () => Pick<IosSdkBridgeClient, "requestSdkActionForIos"> | null;
  enabled?: () => boolean;
}

export function createIosSdkBridgeTapper(options: IosSdkBridgeTapperOptions): IosSdkBridgeTapper {
  const enabled = options.enabled ?? (() => serverConfig.isIosSdkObservationBridgeEnabled());
  return {
    async tap(request) {
      const target = iosSdkBridgeTarget(request.element);
      // A focus tap stays on XCTest: sendKeys sends its text and clear through the bridge, and an
      // XCTest fallback for those needs the field focused the usual way.
      if (!target || !enabled() || request.action === "focus") {
        return null;
      }
      const action = bridgeAction(request, target.elementId, target.observationIdentity);
      if (!action) {
        return { backend: "xctest", fallbackReason: "unsupported" };
      }
      const client = options.client();
      if (!client) {
        return { backend: "xctest", fallbackReason: "unavailable" };
      }
      const reply = await client.requestSdkActionForIos(action, {
        timeoutMs: IOS_SDK_BRIDGE_TAP_TIMEOUT_MS,
        signal: request.signal,
      });
      return iosSdkBridgeActionOutcome(reply, "tap");
    },
  };
}

/** The production tapper: the device's existing runner client, gated by the routing flag. */
export function deviceIosSdkBridgeTapper(
  device: Pick<BootedDevice, "deviceId">,
): IosSdkBridgeTapper {
  return createIosSdkBridgeTapper({
    client: () => IOSCtrlProxyClient.getExistingInstance(device.deviceId),
  });
}
