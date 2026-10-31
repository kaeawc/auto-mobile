import { MAX_SETTIMEOUT_DELAY_MS } from "../../utils/SystemTimer";
import type { BootedDevice, ObserveResult } from "../../models";
import type { SwipeResult } from "../../models/SwipeResult";
import { serverConfig } from "../../utils/ServerConfig";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import type { IosSdkBridgeClient } from "../observe/ios/IosSdkBridgeReader";
import { findIosSdkBridgeTarget, iosSdkBridgeTarget } from "../observe/ios/iosSdkObservationMerge";
import type { IosSdkAction } from "../observe/ios/sdkObservationBridge";
import {
  IOS_SDK_BRIDGE_TAP_TIMEOUT_MS,
  iosSdkBridgeActionOutcome,
  type IosSdkTapOutcome,
} from "./IosSdkBridgeTapRouter";
import type { SwipeGestureRequest, VoiceOverSwipeRunner } from "./swipeon/types";

/**
 * Routes iOS `swipeOn` through the SDK observation bridge (#5159).
 *
 * - A container that is a merged bridge node scrolls through the bridge's `scroll`, with `delta`
 *   the change in content offset in points (opposite to the finger's motion).
 * - A screen swipe on a screen with bridge nodes goes through the bridge's `swipe`, with the same
 *   points XCTest would use, naming the merge it was resolved against.
 * - Only a swipe that passes the observation it was resolved against is routed, and the bridge
 *   identity comes from that capture. Edge swipes (system UI the bridge cannot see) and scroll
 *   searches (whose container was resolved before earlier scrolls) pass none and stay on XCTest.
 *
 * XCTest stands in only for an unavailable bridge or an unsupported action (including a
 * boomerang, which has no bridge form); every other rejection fails closed, as for tapOn.
 */

/** Headroom over the gesture's own duration for the bridge's reply and post-action capture. */
export const IOS_SDK_BRIDGE_SWIPE_HEADROOM_MS = 3000;
export const IOS_SDK_BRIDGE_SWIPE_MIN_TIMEOUT_MS = IOS_SDK_BRIDGE_TAP_TIMEOUT_MS;

/** The gesture budget never undercuts the gesture itself (compare #15821 for long presses). */
export function iosSdkBridgeSwipeTimeoutMs(durationMs: number): number {
  return Math.min(
    Math.max(IOS_SDK_BRIDGE_SWIPE_MIN_TIMEOUT_MS, durationMs + IOS_SDK_BRIDGE_SWIPE_HEADROOM_MS),
    MAX_SETTIMEOUT_DELAY_MS,
  );
}

type BridgeGesture = { action: IosSdkAction; verb: string } | "unsupported" | null;

function bridgeGesture(
  request: SwipeGestureRequest,
  observation: Pick<ObserveResult, "viewHierarchy">,
  durationMs: number,
): BridgeGesture {
  const hierarchy = observation.viewHierarchy;
  if (request.containerElement) {
    const container = iosSdkBridgeTarget(request.containerElement);
    // The capture the swipe was resolved against names the identity, not the container's own.
    const target = container && findIosSdkBridgeTarget(hierarchy, container.elementId);
    if (!target) {
      return null;
    }
    if (request.boomerang) {
      return "unsupported";
    }
    const delta = { x: request.x1 - request.x2, y: request.y1 - request.y2 };
    return { action: { scroll: { ...target, delta } }, verb: "scroll" };
  }
  const screen = findIosSdkBridgeTarget(hierarchy);
  if (!screen) {
    return null;
  }
  if (request.boomerang) {
    return "unsupported";
  }
  const swipe = {
    observationIdentity: screen.observationIdentity,
    start: { x: request.x1, y: request.y1 },
    end: { x: request.x2, y: request.y2 },
    durationMs,
  };
  return { action: { swipe }, verb: "swipe" };
}

export const IOS_SDK_SCROLL_DURATION_WARNING =
  "durationMs was ignored: the app's SDK observation bridge scrolls the container by an offset " +
  "with no timed stroke, so the reported duration is a nominal value.";

/** A bridge scroll has no stroke: its duration is nominal, and flagged when it was requested. */
function withIgnoredScrollDuration(result: SwipeResult, request: SwipeGestureRequest): SwipeResult {
  return {
    ...result,
    durationIgnored: true,
    ...(request.gestureOptions?.durationExplicit
      ? { warnings: [IOS_SDK_SCROLL_DURATION_WARNING] }
      : {}),
  };
}

export interface IosSdkBridgeSwipeRunnerOptions {
  client: () => Pick<IosSdkBridgeClient, "requestSdkActionForIos"> | null;
  enabled?: () => boolean;
}

/** Wraps the XCTest swipe runner; non-bridge swipes pass straight through. */
export class IosSdkBridgeSwipeRunner implements VoiceOverSwipeRunner {
  private readonly enabled: () => boolean;

  constructor(
    private readonly xctest: VoiceOverSwipeRunner,
    private readonly options: IosSdkBridgeSwipeRunnerOptions,
  ) {
    this.enabled = options.enabled ?? (() => serverConfig.isIosSdkObservationBridgeEnabled());
  }

  async executeSwipeGesture(request: SwipeGestureRequest): Promise<SwipeResult> {
    const durationMs = Math.max(0, Math.round(request.gestureOptions?.duration ?? 300));
    const gesture =
      this.enabled() && request.sdkObservation
        ? bridgeGesture(request, request.sdkObservation, durationMs)
        : null;
    if (!gesture) {
      return this.xctest.executeSwipeGesture(request);
    }
    const outcome =
      gesture === "unsupported"
        ? ({ backend: "xctest", fallbackReason: "unsupported" } as const)
        : await this.dispatch(gesture, durationMs, request);
    if (outcome.backend === "sdk") {
      const { x1, y1, x2, y2 } = request;
      const result: SwipeResult = {
        success: true,
        x1,
        y1,
        x2,
        y2,
        duration: durationMs,
        backend: "sdk",
      };
      return gesture !== "unsupported" && gesture.verb === "scroll"
        ? withIgnoredScrollDuration(result, request)
        : result;
    }
    const result = await this.xctest.executeSwipeGesture(request);
    return { ...result, backend: "xctest", fallbackReason: outcome.fallbackReason };
  }

  private async dispatch(
    gesture: { action: IosSdkAction; verb: string },
    durationMs: number,
    request: SwipeGestureRequest,
  ): Promise<IosSdkTapOutcome> {
    // The XCTest route checks the display fence right before dispatch; the bridge's capture check
    // does not replace it, because the bridge keeps its capture until the next observation.
    request.gestureOptions?.displayFence?.assertCurrent();
    const signal = request.signal;
    const client = this.options.client();
    if (!client) {
      return { backend: "xctest", fallbackReason: "unavailable" };
    }
    const reply = await client.requestSdkActionForIos(gesture.action, {
      timeoutMs: iosSdkBridgeSwipeTimeoutMs(durationMs),
      signal,
    });
    return iosSdkBridgeActionOutcome(reply, gesture.verb);
  }
}

/** The production runner: the device's existing runner client, gated by the routing flag. */
export function deviceIosSdkBridgeSwipeRunner(
  device: Pick<BootedDevice, "deviceId">,
  xctest: VoiceOverSwipeRunner,
): VoiceOverSwipeRunner {
  return new IosSdkBridgeSwipeRunner(xctest, {
    client: () => IOSCtrlProxyClient.getExistingInstance(device.deviceId),
  });
}
