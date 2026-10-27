import { DragAndDrop } from "../../features/action/DragAndDrop";
import { PinchOn } from "../../features/action/PinchOn";
import { SwipeOn } from "../../features/action/swipeon";
import { resolveSwipeDirection } from "../../features/action/swipeon/swipeOnUtils";
import { RecompositionTracker } from "../../features/performance/RecompositionTracker";
import {
  BootedDevice,
  PinchOnResult,
  SwipeOnToolPayload,
  type DragAndDropResult,
} from "../../models";
import {
  StructuredToolResponse,
  createJSONToolResponse,
  createStructuredToolResponse,
} from "../../utils/toolUtils";
import type { DragAndDropArgs, PinchOnArgs, SwipeOnArgs } from "../interactionToolTypes";
import { ProgressCallback } from "../toolRegistry";
import type { InteractionToolDependencies } from "./dependencies";

export function formatSwipeOnMessage(
  result: Pick<
    SwipeOnToolPayload,
    "success" | "error" | "found" | "scrollIterations" | "navigated"
  >,
  direction: string,
): string {
  if (!result.success) {
    // `||` not `??`: an empty-string error (`error: ""`) must still yield the
    // non-empty fallback, otherwise the tool returns a blank message (#4183 P4).
    return result.error || `Swipe ${direction} failed`;
  }
  if (result.found) {
    return `Swiped ${direction} and found element after ${result.scrollIterations ?? 1} swipe(s)`;
  }
  // A swipe that opened another screen did not scroll; say so instead of "Swiped up".
  return result.navigated
    ? `Swiped ${direction}, but the screen changed instead of scrolling (see warning)`
    : `Swiped ${direction}`;
}

const defaultSwipeOnFactory: NonNullable<InteractionToolDependencies["swipeOnFactory"]> = (
  device,
) => new SwipeOn(device);

export async function swipeOnHandler(
  device: BootedDevice,
  args: SwipeOnArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
  deps: InteractionToolDependencies = {},
): Promise<StructuredToolResponse<SwipeOnToolPayload> & { isError?: true }> {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const swipeOn = (deps.swipeOnFactory ?? defaultSwipeOnFactory)(device);
  const resolvedDirection = resolveSwipeDirection({
    direction: args.direction,
    gestureType: args.gestureType,
  });
  const result = await swipeOn.execute(
    {
      display: args.display,
      container: args.container,
      // An edge swipe targets the screen/panel edge, never an auto-selected scrollable.
      autoTarget:
        args.display === undefined
          ? (args.autoTarget ?? args.fromEdge === undefined)
          : args.autoTarget,
      // SwipeOnArgs requires a direction, and the resolver's inversion map covers all four values.
      direction: resolvedDirection.direction!,
      lookFor: args.lookFor,
      speed: args.speed,
      durationMs: args.durationMs,
      fromEdge: args.fromEdge,
      edgeInset: args.edgeInset,
      at: args.at,
      includeSystemInsets:
        args.display === undefined ? (args.includeSystemInsets ?? false) : args.includeSystemInsets,
      boomerang: args.boomerang,
      apexPause: args.apexPause,
      returnSpeed: args.returnSpeed,
      layer: args.layer,
    },
    { progress, signal },
  );

  const response = createStructuredToolResponse({
    message: formatSwipeOnMessage(result, args.direction),
    observation: result.observation,
    ...result,
  });
  // formatSwipeOnMessage already gates the message on `result.success`; the MCP
  // envelope must agree, exactly as tapOn does (#6152, #5902), so a
  // conforming client can't mistake a failed swipe for a completed one (#6163).
  return result.success ? response : { ...response, isError: true };
}

export function formatPinchOnMessage(
  result: Pick<PinchOnResult, "success" | "error">,
  direction: string,
): string {
  if (!result.success) {
    // `||` not `??`: an empty-string error (`error: ""`) must still yield the
    // non-empty fallback, mirroring formatSwipeOnMessage (#4183 P4). Without this
    // a validation failure (e.g. scale:0) reported a success-shaped message (#6056).
    return result.error || `Pinch ${direction} failed`;
  }
  return `Pinched ${direction}`;
}

const defaultPinchOnFactory: NonNullable<InteractionToolDependencies["pinchOnFactory"]> = (
  device,
) => new PinchOn(device);

export async function pinchOnHandler(
  device: BootedDevice,
  args: PinchOnArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
  deps: InteractionToolDependencies = {},
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const pinchOn = (deps.pinchOnFactory ?? defaultPinchOnFactory)(device);
  const result = await pinchOn.execute(
    {
      display: args.display,
      direction: args.direction,
      distanceStart: args.distanceStart,
      distanceEnd: args.distanceEnd,
      scale: args.scale,
      duration: args.duration,
      rotationDegrees: args.rotationDegrees,
      includeSystemInsets: args.includeSystemInsets,
      container: args.container,
      autoTarget: args.autoTarget,
      layer: args.layer,
    },
    { progress, signal },
  );

  const response = createJSONToolResponse({
    message: formatPinchOnMessage(result, args.direction),
    observation: result.observation,
    ...result,
  });
  // formatPinchOnMessage already gates the message on `result.success`; the MCP
  // envelope must agree, exactly as tapOn does (#6152, #5902), so a
  // conforming client can't mistake a failed pinch for a completed one (#6163).
  return result.success ? response : { ...response, isError: true };
}

const defaultDragAndDropFactory: NonNullable<InteractionToolDependencies["dragAndDropFactory"]> = (
  device,
) => new DragAndDrop(device);

export async function dragAndDropHandler(
  device: BootedDevice,
  args: DragAndDropArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
  deps: InteractionToolDependencies = {},
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const dragAndDrop = (deps.dragAndDropFactory ?? defaultDragAndDropFactory)(device);
  const result: DragAndDropResult = await dragAndDrop.execute(
    {
      display: args.display,
      source: args.source,
      target: args.target,
      layer: args.layer,
      pressDurationMs: args.pressDurationMs,
      dragDurationMs: args.dragDurationMs,
      holdDurationMs: args.holdDurationMs,
    },
    { progress, signal },
  );

  const message = result.success
    ? "Dragged element to target"
    : `Failed to drag element to target: ${result.error || "unknown error"}`;
  const response = createJSONToolResponse({
    message,
    observation: result.observation,
    ...result,
  });
  return result.success ? response : { ...response, isError: true as const };
}
