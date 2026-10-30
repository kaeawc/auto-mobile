import { AndroidCtrlProxyClient, type AndroidCtrlProxy } from "../../features/observe/android";
import { getToolSelectionContext } from "../../features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../models";
import { SessionNoLongerOwnsDeviceError } from "../../models/sessionNoLongerOwnsDevice";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { executionTracker } from "../executionTracker";
import { GestureOwnershipRegistry } from "../gestureOwnership";
import { InputDeviceOwnedError } from "../inputDeviceOwnership";
import { type InputGestureParams } from "../inputRouteParams";
import { GESTURE_FRAME_METHODS, type GestureFrameKind } from "../inputRoutes";
import { DaemonRequest } from "../types";
import { isSessionRefusal } from "./errorFrames";
import type {
  InputRequestContext,
  InputRouteArgs,
  InputRouteResult,
  InputRouteRun,
} from "./inputDeviceGating";
import { type McpForwardChainWait } from "./keyedSerialQueue";

/** What held the device when a `gestureStart` was admitted (#11541). */
export interface StrokeAdmission {
  deviceId: string;
  /** The admitting holder; absent for a start on a device no session held. */
  holderSessionId?: string;
  /** The holder's session object: a re-created session with the same id is another holder. */
  holderIncarnation?: object;
  /** Aborted when the frame's tracked execution or its owner was cancelled. */
  signal?: AbortSignal;
}

/**
 * The answer to a `gestureStart` whose stroke was lifted because its admission ended before the
 * ack: whatever aborted the frame (the typed release or ownership refusal), else that the holder
 * changed.
 */
export function strokeAdmissionEndedError(method: string, admission: StrokeAdmission): unknown {
  if (admission.signal?.aborted) {
    return admission.signal.reason;
  }
  const { deviceId, holderSessionId } = admission;
  const lifted = (cause: string) =>
    `${method} on device '${deviceId}' was lifted: ${cause} before the stroke's start was acknowledged.`;
  // Typed like the frames that follow the lifted start (#11351): the admitting holder left the
  // device, or a session now holds a device the sessionless start was admitted on.
  return holderSessionId
    ? new SessionNoLongerOwnsDeviceError(
        holderSessionId,
        deviceId,
        lifted(`session ${holderSessionId} no longer holds the device`),
      )
    : new InputDeviceOwnedError(method, deviceId, undefined, undefined, {
        message: lifted("a session acquired the device"),
      });
}

/** Timeout for the best-effort cancelling `gestureEnd` issued when a socket owning a gesture closes. */
export const OWNED_GESTURE_CANCEL_TIMEOUT_MS = 5000;

/** Server state and method seams are resolved lazily so instance overrides remain effective. */
export interface InputStrokesPorts {
  parseInputGestureParams(params: unknown, method: string): InputGestureParams;
  runInputRoute<A extends InputRouteArgs, R extends InputRouteResult>(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    input: InputRequestContext | undefined,
    route: InputRouteRun<A, R>,
  ): Promise<{ targetDevice: BootedDevice; result: R }>;
  liftingStrokeOnSessionRefusal: InputStrokes["liftingStrokeOnSessionRefusal"];
  forwardGestureFrame: InputStrokes["forwardGestureFrame"];
  captureStrokeAdmission: InputStrokes["captureStrokeAdmission"];
  forwardGestureStart: InputStrokes["forwardGestureStart"];
  trackAckedGestureFrame: InputStrokes["trackAckedGestureFrame"];
  ownedGestures: () => Pick<
    GestureOwnershipRegistry,
    | "onEndAcked"
    | "onStartAcked"
    | "cancelIfDeviceChangedHands"
    | "cancelAllUnheldOn"
    | "cancelAllHeldByOn"
    | "cancelAllHeldBy"
  >;
  strokeAdmissionStillHolds: InputStrokes["strokeAdmissionStillHolds"];
  cancelGestureOnDevice: InputStrokes["cancelGestureOnDevice"];
  getSessionForDevice(deviceId: string): string | undefined;
  getSessionIncarnation(sessionUuid: string | undefined): object | undefined;
  trackRequestHandler(handler: Promise<void>): void;
  runKeyedMcpForward<T>(
    executionKey: string,
    fn: () => Promise<T>,
    idleCloseKey?: string,
    chainWait?: McpForwardChainWait,
  ): Promise<T>;
}

/** Input operations; mutable state remains owned by UnixSocketServer. */
export class InputStrokes {
  constructor(private readonly ports: InputStrokesPorts) {}

  /**
   * One streamed-gesture frame (start / move / end). A live drag arrives as one `input/gestureStart`,
   * many `input/gestureMove`, and one `input/gestureEnd` sharing a `gestureId`; the runner chains
   * them into a single continued on-device gesture. Android only — streaming has no XCUITest
   * equivalent, so the desktop client keeps the atomic `input/swipe` for iOS and old daemons.
   *
   * Frame-identity-free like taps: no `frameContext` is required or checked, so a snapshot advancing
   * mid-drag cannot reject an in-flight gesture as stale. Each frame is serialized through the same
   * per-device keyed forward as taps/swipes, so gesture ordering is preserved.
   */
  async handleInputGesture(
    request: DaemonRequest,
    kind: GestureFrameKind,
    socketSessionId?: string,
    input?: InputRequestContext,
  ) {
    const method = GESTURE_FRAME_METHODS[kind];
    const args = this.ports.parseInputGestureParams(request.params, method);
    let startAdmission: StrokeAdmission | undefined;
    const { targetDevice, result: gestureResult } = await this.ports.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: method,
        origin: "UnixSocketServer.handleInputGesture",
        args,
        // Frame-identity-free: no frameContext is required or checked.
        checksFrame: false,
        around: (device, run) =>
          this.ports.liftingStrokeOnSessionRefusal(kind, socketSessionId, device, {
            gestureId: args.gestureId,
            run,
          }),
        dispatch: async ({ targetDevice, signal, dispatching, remainingTimeoutMs }) => {
          // Before the start's admission is captured: it reads the session this frame uses.
          dispatching?.();
          const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
          if (kind !== "start") {
            return this.ports.forwardGestureFrame(client, kind, args, remainingTimeoutMs);
          }
          startAdmission = this.ports.captureStrokeAdmission(targetDevice.deviceId, signal);
          return this.ports.forwardGestureStart(client, args, remainingTimeoutMs, startAdmission);
        },
      },
    );

    if (!gestureResult.success) {
      throw new Error(gestureResult.error ?? `${method} failed on ${args.platform}`);
    }

    if (socketSessionId) {
      await this.ports.trackAckedGestureFrame(kind, socketSessionId, targetDevice, {
        gestureId: args.gestureId,
        startAdmission,
      });
    }

    return {
      action: method,
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      gestureId: args.gestureId,
      point: { x: args.x, y: args.y },
      ...(kind === "end" ? { cancel: args.cancel } : {}),
    };
  }

  /**
   * Track ownership so a socket that tears down mid-drag can lift its still-open on-device stroke.
   * Only an acked start opens the gesture; an end (release OR cancel) closes it. A socket-less
   * forward (no client session) can't be cancelled on close, so it isn't tracked.
   */
  async trackAckedGestureFrame(
    kind: "start" | "move" | "end",
    socketSessionId: string,
    targetDevice: BootedDevice,
    { gestureId, startAdmission }: { gestureId: string; startAdmission?: StrokeAdmission },
  ): Promise<void> {
    if (kind === "end") {
      this.ports.ownedGestures().onEndAcked(socketSessionId, targetDevice.deviceId, gestureId);
      return;
    }
    if (kind !== "start") {
      return;
    }
    // A start acked after its socket closed is cancelled here instead of recorded (#10005), and so
    // is one whose holder left the device since the in-slot check of `forwardGestureStart`
    // (#11541). Evaluated in the same turn the stroke is recorded, so no release or acquisition
    // can land between the check and the record.
    const admissionHolds = !startAdmission || this.ports.strokeAdmissionStillHolds(startAdmission);
    await this.ports
      .ownedGestures()
      .onStartAcked(
        socketSessionId,
        targetDevice,
        gestureId,
        startAdmission?.holderSessionId,
        admissionHolds,
      );
    if (startAdmission && !admissionHolds) {
      throw strokeAdmissionEndedError(GESTURE_FRAME_METHODS.start, startAdmission);
    }
  }

  /**
   * Each gesture frame is its own control call, so a `gestureMove`/`gestureEnd` can be refused at
   * session admission (suspect, or released) after its `gestureStart` was admitted (#11417). The
   * runner parks a continued stroke with no ceiling, so the refused frame would leave the pointer
   * down: the daemon lifts the stroke with a cancelling end (no drop is committed) and then
   * answers the typed refusal. A refused `gestureStart` opened nothing.
   *
   * A frame refused for any other reason (the holder gate's `device_owned_by_other_session`, a
   * target resolved for a holder that has left) lifts the stroke this socket owns when the device
   * is no longer held by the session the start was admitted under (#11448): the holder was
   * released between frames, and the stroke must not stay down on the next owner's device.
   */
  async liftingStrokeOnSessionRefusal<T>(
    kind: "start" | "move" | "end",
    socketSessionId: string | undefined,
    targetDevice: BootedDevice,
    { gestureId, run }: { gestureId: string; run: () => Promise<T> },
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (kind !== "start" && isSessionRefusal(error)) {
        try {
          await this.ports.cancelGestureOnDevice(targetDevice, gestureId);
        } catch (cancelError) {
          logger.warn(
            `Failed to lift gesture ${gestureId} on ${targetDevice.deviceId} after its session ` +
              `refused a frame: ${errorMessage(cancelError)}`,
          );
        }
        if (socketSessionId) {
          this.ports.ownedGestures().onEndAcked(socketSessionId, targetDevice.deviceId, gestureId);
        }
      } else if (kind !== "start" && socketSessionId) {
        await this.ports
          .ownedGestures()
          .cancelIfDeviceChangedHands(
            socketSessionId,
            targetDevice.deviceId,
            gestureId,
            this.ports.getSessionForDevice(targetDevice.deviceId),
          );
      }
      throw error;
    }
  }

  /**
   * The holder a `gestureStart` is being sent under, read in the device's slot immediately before
   * the frame leaves: the session the tracked execution was admitted under and that session's
   * incarnation (a released session re-created under the same id is a different holder), or no
   * holder for a start on a device no session held.
   */
  captureStrokeAdmission(deviceId: string, signal?: AbortSignal): StrokeAdmission {
    const executionId = getToolSelectionContext()?.execution?.executionId;
    const holderSessionId = executionId
      ? executionTracker.getAdmittedSessionUse(executionId)
      : undefined;
    return {
      deviceId,
      ...(holderSessionId !== undefined ? { holderSessionId } : {}),
      holderIncarnation: this.ports.getSessionIncarnation(holderSessionId),
      ...(signal ? { signal } : {}),
    };
  }

  /**
   * Whether the device is still held exactly as it was when the start was admitted: the frame was
   * not aborted (a release that cuts, a session acquiring a free device, a cancel), and the device
   * has the same holder incarnation, or still none. Synchronous, so a caller that records the
   * stroke in the same turn cannot be overtaken by a release or an acquisition.
   */
  strokeAdmissionStillHolds(admission: StrokeAdmission): boolean {
    if (admission.signal?.aborted) {
      return false;
    }
    if (this.ports.getSessionForDevice(admission.deviceId) !== admission.holderSessionId) {
      return false;
    }
    return (
      this.ports.getSessionIncarnation(admission.holderSessionId) === admission.holderIncarnation
    );
  }

  /**
   * Send a `gestureStart` from inside the device's slot and, once the runner acks it, check that
   * its admission still holds. A release that cuts does not wait for the ack and streamed frames
   * carry no abort to the runner, so the pointer can go down for a holder that has already left:
   * the release-time lift found no stroke, and recording this one would leave it down on a freed
   * device (#11541). The same goes for a sessionless start whose device a session acquired
   * meanwhile (#10829). Such a start is cancelled here, on the runner directly because this call
   * still occupies the device's slot, so the lift precedes anything queued behind the start, and
   * the frame answers what ended its admission. A failed cancel is logged and the refusal still
   * answered. A start the runner did not accept opened nothing and is never cancelled.
   */
  async forwardGestureStart(
    client: AndroidCtrlProxy,
    args: { gestureId: string; x: number; y: number; cancel: boolean },
    timeoutMs: number,
    admission: StrokeAdmission,
  ) {
    const started = await this.ports.forwardGestureFrame(client, "start", args, timeoutMs);
    if (!started.success || this.ports.strokeAdmissionStillHolds(admission)) {
      return started;
    }
    try {
      await client.requestGestureEnd(args.gestureId, 0, 0, {
        cancel: true,
        timeoutMs: OWNED_GESTURE_CANCEL_TIMEOUT_MS,
      });
    } catch (error) {
      logger.warn(
        `Failed to lift gesture ${args.gestureId} on ${admission.deviceId} whose holder left ` +
          `before its start was acked: ${errorMessage(error)}`,
      );
    }
    throw strokeAdmissionEndedError(GESTURE_FRAME_METHODS.start, admission);
  }

  /**
   * A session acquired `deviceId`: lift every stroke that was started on it while no session held
   * it, at acquisition time, so the cancel is on the device's keyed queue ahead of the new holder's
   * first call (#10829, #11541). With no frame in flight nothing else would lift the pointer until
   * the pane sent another frame or its socket closed. Best-effort; never throws.
   */
  liftSessionlessStrokesOn(deviceId: string): void {
    this.ports.trackRequestHandler(this.ports.ownedGestures().cancelAllUnheldOn(deviceId));
  }

  /** Queue the old device's holder strokes before rebind makes it available (#11667). */
  liftStrokesHeldByOn(sessionId: string, deviceId: string): void {
    // Forced same-serial rebinds also notify unbound; the holder kept this device.
    if (this.ports.getSessionForDevice(deviceId) === sessionId) {
      return;
    }
    this.ports.trackRequestHandler(
      this.ports.ownedGestures().cancelAllHeldByOn(sessionId, deviceId),
    );
  }

  /**
   * A session was released: lift every stroke admitted under it, at release time, so the cancel is
   * on the device's keyed queue ahead of any input the next owner sends (#11448). The frames of a
   * gesture are separate control calls, so a release between two of them cuts no call and nothing
   * else would lift the pointer until the pane's socket closed. Best-effort; never throws.
   */
  liftStrokesHeldBy(releasedSessionId: string): Promise<void> {
    return this.ports.ownedGestures().cancelAllHeldBy(releasedSessionId);
  }

  /**
   * Cancelling `gestureEnd` for one gesture, forwarded through the same per-device keyed queue as
   * live frames so it can't race an in-flight frame.
   */
  cancelGestureOnDevice(targetDevice: BootedDevice, gestureId: string): Promise<unknown> {
    return this.ports.runKeyedMcpForward(
      `device:${targetDevice.deviceId}`,
      async () => {
        const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
        // Coordinates are ignored for a cancel (the runner lifts in place), so 0,0 is fine.
        return client.requestGestureEnd(gestureId, 0, 0, {
          cancel: true,
          timeoutMs: OWNED_GESTURE_CANCEL_TIMEOUT_MS,
        });
      },
      `device:${targetDevice.deviceId}`,
    );
  }

  /** Relay one gesture frame to the Android runner's continued-gesture path. */
  forwardGestureFrame(
    client: AndroidCtrlProxy,
    kind: "start" | "move" | "end",
    args: { gestureId: string; x: number; y: number; cancel: boolean },
    timeoutMs: number,
  ) {
    const { gestureId, x, y, cancel } = args;
    switch (kind) {
      case "start":
        return client.requestGestureStart({ gestureId, x, y, timeoutMs });
      case "move":
        return client.requestGestureMove(gestureId, x, y, { timeoutMs });
      case "end":
        return client.requestGestureEnd(gestureId, x, y, { cancel, timeoutMs });
    }
  }
}
