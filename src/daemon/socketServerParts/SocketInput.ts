import { type GestureFrameKind } from "../inputRoutes";

import { resolveMcpRequestTimeoutMsOnce } from "../mcpRequestTimeout";

import { McpTimeoutError } from "../wire/McpTimeoutError";

import { DaemonRequest } from "../types";

import { AndroidCtrlProxyClient, type AndroidCtrlProxy } from "../../features/observe/android";
import { IOSCtrlProxyClient, type IosCtrlProxy } from "../../features/observe/ios";
import { PressButton } from "../../features/action/PressButton";
import {
  INPUT_KEY_IOS_UNSUPPORTED_ERROR,
  InputKey,
  type InputKeyName,
} from "../../features/action/InputKey";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { canonicalPixelsToPoints } from "../canonicalPixels";
import { ActionableError, toActionableError } from "../../models/ActionableError";

import type { BootedDevice, ScreenScaleMetadata } from "../../models";

import {
  type InputRequestContext,
  type InputRouteArgs,
  type InputRouteResult,
  type InputRouteRun,
} from "../socketServer/inputDeviceGating";
import { InputStrokes, type StrokeAdmission } from "../socketServer/inputStrokes";

import { assertSocketInputNotAborted } from "./socketServerContracts";

import type { SocketServerRuntime } from "./SocketServerRuntime";
import type { SocketServerOperations } from "./socketServerOperations";
/** The two calls the iOS input-coordinate scale probe makes. */
type IosRunnerScaleClient = Pick<
  IosCtrlProxy,
  "getScreenScaleMetadata" | "requestHierarchySyncWithoutObservationStreamPush"
>;
type State = Pick<SocketServerRuntime, "timer" | "confirmedLegacyScaleDevices" | "ownedGestures">;
type Callbacks = Pick<
  SocketServerOperations,
  | "inputRouteClock"
  | "resolveInputTargetDevice"
  | "runTrackedKeyedDeviceInput"
  | "requireCurrentFrameContext"
  | "remainingInputBudgetMs"
  | "inputDeviceGate"
  | "parseInputTapParams"
  | "runInputRoute"
  | "requireCoordinatesWithinKnownScreenGeometry"
  | "dispatchFencedInput"
  | "toIosRunnerCoordinates"
  | "remainingBudgetAfterProbe"
  | "parseInputSwipeParams"
  | "parseInputPressButtonParams"
  | "holdDispatchedInputRequest"
  | "parseInputKeyParams"
  | "executeSocketInputKey"
  | "runHeldInputOperation"
  | "runInputOperationWithTimeout"
  | "parseInputGestureParams"
  | "liftingStrokeOnSessionRefusal"
  | "forwardGestureFrame"
  | "captureStrokeAdmission"
  | "forwardGestureStart"
  | "trackAckedGestureFrame"
  | "strokeAdmissionStillHolds"
  | "cancelGestureOnDevice"
  | "getSessionForDevice"
  | "getSessionIncarnation"
  | "trackRequestHandler"
  | "runKeyedMcpForward"
>;
/** Socket Input over shared connection state and explicit callbacks. */
export class SocketInput {
  constructor(
    private readonly state: State,
    private readonly resolveCallbacks: () => Callbacks,
  ) {}
  private get callbacks(): Callbacks {
    return this.resolveCallbacks();
  }
  /**
   * Convert incoming `input/*` coordinates to the units the iOS XCUITest runner expects (points).
   *
   * A control client that renders a canonical-pixel observation frame (#4549) sends taps/swipes in
   * PIXELS, so divide by the runner-reported `nativeScale` before dispatch — the inverse of the
   * daemon's publish-side point->pixel conversion, so the tap lands at the same physical location.
   * The divide is EXACT (fractional points; XCUITest accepts them), so the round-trip carries only
   * the single publish-side quantization.
   *
   * The scale metadata is populated by #4548 on hierarchy RECEIPT, which has not happened yet if a
   * control client sends its first input before the daemon has received any hierarchy for this
   * device — dispatching those pixels as points would land a 3x tap at 1/3 scale. So when the
   * metadata is null we fetch one hierarchy first (no observation-stream push, bounded by
   * `probeTimeoutMs`) to populate it, then decide:
   *  - probe FAILS (throws, or returns no hierarchy — not connected / timed out): fail closed with
   *    an actionable error rather than mis-dispatching; do NOT cache (the next input re-probes).
   *  - probe SUCCEEDS but the runner carries no metadata: a genuine pre-#4548 legacy runner, whose
   *    control client sends point-space coordinates — pass through, and cache the verdict so
   *    subsequent legacy taps skip the round trip. The cache entry is dropped the moment metadata
   *    appears, so a runner upgrade is not pinned to the legacy verdict.
   *
   * The caller must charge the probe's elapsed time against the gesture budget (recompute the
   * remaining timeout after this resolves) so probe + gesture never exceed one request budget.
   */
  /**
   * The gesture budget remaining after the iOS scale probe (if any) ran, charging its elapsed
   * wall-time against the request's total budget so probe + gesture never exceed one budget (#3351).
   * Throws a timeout when the probe already consumed the budget, rather than starting a full-budget
   * gesture on top of it. On the common path (metadata already known) the probe is synchronous, so
   * the elapsed time is just the queue wait and this returns ~the full remaining budget.
   */
  remainingBudgetAfterProbe(
    queueEnterMs: number,
    totalTimeoutMs: number,
    toolName: string,
    origin: string,
  ): number {
    const remaining = totalTimeoutMs - (this.state.timer.now() - queueEnterMs);
    if (remaining <= 0) {
      throw new McpTimeoutError({
        toolName,
        timeoutMs: totalTimeoutMs,
        origin: `UnixSocketServer.${origin}`,
        detail: "iOS screen-scale probe consumed the request budget",
      });
    }
    return remaining;
  }
  async toIosRunnerCoordinates(
    client: IosRunnerScaleClient,
    deviceId: string,
    coordinates: number[],
    probeTimeoutMs: number,
    validateCanonicalCoordinates?: (geometry: ScreenScaleMetadata) => void,
  ): Promise<number[]> {
    const knownMetadata = client.getScreenScaleMetadata();
    if (knownMetadata) {
      // Metadata present: a runner upgrade drops any stale confirmed-legacy verdict for this device.
      this.state.confirmedLegacyScaleDevices.delete(deviceId);
      validateCanonicalCoordinates?.(knownMetadata);
      return coordinates.map((coordinate) =>
        canonicalPixelsToPoints(coordinate, knownMetadata.nativeScale),
      );
    }
    if (this.state.confirmedLegacyScaleDevices.has(deviceId)) {
      // A prior probe SUCCEEDED with no metadata: a confirmed legacy runner. Skip the round trip.
      return coordinates;
    }
    // Startup window: no hierarchy received yet, so #4548 receipt-based retention has not run. Fetch
    // one (without an observation-stream push) so the scale is known before we decide the space.
    let probed: unknown;
    try {
      probed = await client.requestHierarchySyncWithoutObservationStreamPush(
        undefined,
        false,
        undefined,
        probeTimeoutMs,
      );
    } catch (error) {
      // Probe threw: a transient failure, NOT evidence of a legacy runner. Fail closed rather than
      // mis-dispatching pixels as points.
      throw toActionableError(
        error,
        `Could not determine iOS screen scale for ${deviceId}; the input coordinate scale probe failed`,
      );
    }
    if (!probed) {
      // Probe returned no hierarchy (not connected / timed out): a FAILURE, distinct from a runner
      // that answered with no metadata. Fail closed and do NOT cache — the next input re-probes.
      throw new ActionableError(
        `Could not determine iOS screen scale for ${deviceId}: the hierarchy probe returned no data. ` +
          `Retry once the device has produced a hierarchy.`,
      );
    }
    const probedMetadata = client.getScreenScaleMetadata();
    if (!probedMetadata) {
      // Probe SUCCEEDED but the runner reported no scale metadata: a genuine pre-#4548 legacy
      // runner. The control client never received px bounds, so it sends points — pass through, and
      // cache the verdict so subsequent legacy taps skip the probe.
      this.state.confirmedLegacyScaleDevices.add(deviceId);
      return coordinates;
    }
    validateCanonicalCoordinates?.(probedMetadata);
    return coordinates.map((coordinate) =>
      canonicalPixelsToPoints(coordinate, probedMetadata.nativeScale),
    );
  }
  /**
   * Canonical pixel bounds arrive with the complete runner metadata. A missing tuple is a legacy
   * runner or an unseen hierarchy, where preserving the existing pass-through behavior is safer
   * than guessing dimensions.
   */
  requireCoordinatesWithinKnownScreenGeometry(
    coordinates: readonly [number, number],
    geometry: ScreenScaleMetadata | null,
  ): void {
    if (!geometry) {
      return;
    }
    const [x, y] = coordinates;
    if (x < 0 || x >= geometry.pixelWidth || y < 0 || y >= geometry.pixelHeight) {
      throw new Error(
        `input/tap coordinates x=${x}, y=${y} are outside device canonical pixel bounds ` +
          `x: 0..${geometry.pixelWidth - 1}, y: 0..${geometry.pixelHeight - 1}`,
      );
    }
  }
  /** When an `input/*` request entered the queue and the whole budget it was given. */
  inputRouteClock(
    request: DaemonRequest,
    input: InputRequestContext | undefined,
  ): {
    queueEnterMs: number;
    totalTimeoutMs: number;
  } {
    return {
      queueEnterMs: input?.receivedAtMs ?? this.state.timer.now(),
      totalTimeoutMs: resolveMcpRequestTimeoutMsOnce(request),
    };
  }
  /**
   * Time left in an input request's budget after its wait in the device queue; the one copy of the
   * check every `input/*` route makes once it reaches the front of the queue (#11814).
   */
  remainingInputBudgetMs(
    toolName: string,
    origin: string,
    queueEnterMs: number,
    totalTimeoutMs: number,
  ): number {
    const queueWaitMs = this.state.timer.now() - queueEnterMs;
    const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
    if (remainingTimeoutMs <= 0) {
      throw new McpTimeoutError({
        toolName,
        timeoutMs: totalTimeoutMs,
        origin,
        detail: `spent ${queueWaitMs}ms waiting in queue`,
      });
    }
    return remainingTimeoutMs;
  }
  /**
   * The one skeleton every `input/*` route runs: resolve the target device, run the route's
   * dispatch as a tracked keyed device input, and inside that callback check, in this order, the
   * owner has not gone, (typeText append) re-resolve the device, the frame context is current, and
   * the budget survived the queue wait. Only then does `dispatch` run, so the idle stamp
   * (`dispatching`) a route passes to its device write can never precede a pre-dispatch refusal.
   */
  async runInputRoute<A extends InputRouteArgs, R extends InputRouteResult>(
    request: DaemonRequest,
    socketSessionId: string | undefined,
    input: InputRequestContext | undefined,
    route: InputRouteRun<A, R>,
  ): Promise<{
    targetDevice: BootedDevice;
    result: R;
  }> {
    const { queueEnterMs, totalTimeoutMs } = this.callbacks.inputRouteClock(request, input);
    const { args } = route;
    const targetDevice = await this.callbacks.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      route.action,
      {
        bypassAndroidDeviceListCache: route.bypassAndroidDeviceListCache ?? false,
        requester: input?.requester,
      },
    );
    const keyed = () =>
      this.callbacks.runTrackedKeyedDeviceInput(
        request.method,
        targetDevice,
        async (signal, dispatching) => {
          assertSocketInputNotAborted(signal);
          const executionDevice = route.reresolve
            ? await route.reresolve(targetDevice)
            : targetDevice;
          if (route.checksFrame) {
            this.callbacks.requireCurrentFrameContext(
              targetDevice.deviceId,
              args.frameContext,
              route.action,
            );
          }
          const remainingTimeoutMs = this.callbacks.remainingInputBudgetMs(
            request.method,
            route.origin,
            queueEnterMs,
            totalTimeoutMs,
          );
          return await route.dispatch({
            targetDevice,
            executionDevice,
            signal,
            dispatching,
            remainingTimeoutMs,
            queueEnterMs,
            totalTimeoutMs,
          });
        },
        this.callbacks.inputDeviceGate(
          request.method,
          route.origin,
          totalTimeoutMs,
          queueEnterMs,
          input,
        ),
      );
    const result = await (route.around ? route.around(targetDevice, keyed) : keyed());
    return { targetDevice, result };
  }
  async handleInputTap(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const args = this.callbacks.parseInputTapParams(request.params);
    const { targetDevice, result: gestureResult } = await this.callbacks.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: "input/tap",
        origin: "UnixSocketServer.handleInputTap",
        args,
        checksFrame: true,
        dispatch: async ({
          targetDevice,
          signal,
          dispatching,
          remainingTimeoutMs,
          queueEnterMs,
          totalTimeoutMs,
        }) => {
          if (args.platform === "android") {
            const client = AndroidCtrlProxyClient.getInstance(
              targetDevice,
              defaultAdbClientFactory,
            );
            this.callbacks.requireCoordinatesWithinKnownScreenGeometry(
              [args.x, args.y],
              client.getScreenScaleMetadata?.() ?? null,
            );
            // The signal reaches the send step itself, so an owner that went away while the client
            // was still connecting never has its tap written to the device (#10006).
            return await this.callbacks.dispatchFencedInput(
              "Tap",
              signal,
              remainingTimeoutMs,
              (fenced, onDispatch) =>
                client.requestTapCoordinates({
                  x: args.x,
                  y: args.y,
                  duration: args.duration,
                  timeoutMs: remainingTimeoutMs,
                  frameContext: args.frameContext,
                  onDispatch,
                  signal: fenced,
                }),
              dispatching,
            );
          }
          const iosClient = IOSCtrlProxyClient.getInstance(targetDevice);
          const [x, y] = await this.callbacks.toIosRunnerCoordinates(
            iosClient,
            targetDevice.deviceId,
            [args.x, args.y],
            remainingTimeoutMs,
            (geometry) =>
              this.callbacks.requireCoordinatesWithinKnownScreenGeometry(
                [args.x, args.y],
                geometry,
              ),
          );
          const gestureTimeoutMs = this.callbacks.remainingBudgetAfterProbe(
            queueEnterMs,
            totalTimeoutMs,
            request.method,
            "handleInputTap",
          );
          // The scale probe awaited the runner; the owner may have left meanwhile.
          assertSocketInputNotAborted(signal);
          return await this.callbacks.dispatchFencedInput(
            "Tap",
            signal,
            gestureTimeoutMs,
            (fenced, onDispatch) =>
              iosClient.requestTapCoordinates({
                x,
                y,
                duration: args.duration,
                timeoutMs: gestureTimeoutMs,
                frameContext: args.frameContext,
                signal: fenced,
                onDispatch,
              }),
            dispatching,
          );
        },
      },
    );
    if (!gestureResult.success) {
      throw new Error(gestureResult.error ?? `input/tap failed on ${args.platform}`);
    }
    return {
      action: "input/tap",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      coordinates: { x: args.x, y: args.y },
    };
  }
  async handleInputSwipe(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const args = this.callbacks.parseInputSwipeParams(request.params);
    const { targetDevice, result: gestureResult } = await this.callbacks.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: "input/swipe",
        origin: "UnixSocketServer.handleInputSwipe",
        args,
        checksFrame: true,
        dispatch: async ({
          targetDevice,
          signal,
          dispatching,
          remainingTimeoutMs,
          queueEnterMs,
          totalTimeoutMs,
        }) => {
          if (args.platform === "android") {
            const client = AndroidCtrlProxyClient.getInstance(
              targetDevice,
              defaultAdbClientFactory,
            );
            return await this.callbacks.dispatchFencedInput(
              "Swipe",
              signal,
              remainingTimeoutMs,
              (fenced, onDispatch) =>
                client.requestSwipe({
                  x1: args.startX,
                  y1: args.startY,
                  x2: args.endX,
                  y2: args.endY,
                  duration: args.durationMs,
                  timeoutMs: remainingTimeoutMs,
                  contextOptions: args.frameContext,
                  onDispatch,
                  signal: fenced,
                }),
              dispatching,
            );
          }
          const client = IOSCtrlProxyClient.getInstance(targetDevice);
          const [startX, startY, endX, endY] = await this.callbacks.toIosRunnerCoordinates(
            client,
            targetDevice.deviceId,
            [args.startX, args.startY, args.endX, args.endY],
            remainingTimeoutMs,
          );
          const gestureTimeoutMs = this.callbacks.remainingBudgetAfterProbe(
            queueEnterMs,
            totalTimeoutMs,
            request.method,
            "handleInputSwipe",
          );
          assertSocketInputNotAborted(signal);
          return await this.callbacks.dispatchFencedInput(
            "Swipe",
            signal,
            gestureTimeoutMs,
            (fenced, onDispatch) =>
              client.requestDrag({
                x1: startX,
                y1: startY,
                x2: endX,
                y2: endY,
                pressDurationMs: 0,
                dragDurationMs: args.durationMs,
                holdDurationMs: 0,
                timeoutMs: gestureTimeoutMs,
                frameContext: args.frameContext,
                signal: fenced,
                onDispatch,
              }),
            dispatching,
          );
        },
      },
    );
    if (!gestureResult.success) {
      throw new Error(gestureResult.error ?? `input/swipe failed on ${args.platform}`);
    }
    return {
      action: "input/swipe",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      start: { x: args.startX, y: args.startY },
      end: { x: args.endX, y: args.endY },
      durationMs: args.durationMs,
    };
  }
  async handleInputGesture(
    request: DaemonRequest,
    kind: GestureFrameKind,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    return await this.inputStrokes.handleInputGesture(request, kind, socketSessionId, input);
  }
  async trackAckedGestureFrame(
    kind: "start" | "move" | "end",
    socketSessionId: string,
    targetDevice: BootedDevice,
    gestureId: string,
    startAdmission: StrokeAdmission | undefined,
  ): Promise<void> {
    return await this.inputStrokes.trackAckedGestureFrame(
      kind,
      socketSessionId,
      targetDevice,
      gestureId,
      startAdmission,
    );
  }
  async liftingStrokeOnSessionRefusal<T>(
    kind: "start" | "move" | "end",
    socketSessionId: string | undefined,
    targetDevice: BootedDevice,
    gestureId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    return await this.inputStrokes.liftingStrokeOnSessionRefusal(
      kind,
      socketSessionId,
      targetDevice,
      gestureId,
      run,
    );
  }
  captureStrokeAdmission(deviceId: string, signal?: AbortSignal): StrokeAdmission {
    return this.inputStrokes.captureStrokeAdmission(deviceId, signal);
  }
  strokeAdmissionStillHolds(admission: StrokeAdmission): boolean {
    return this.inputStrokes.strokeAdmissionStillHolds(admission);
  }
  async forwardGestureStart(
    client: AndroidCtrlProxy,
    args: {
      gestureId: string;
      x: number;
      y: number;
      cancel: boolean;
    },
    timeoutMs: number,
    admission: StrokeAdmission,
  ) {
    return await this.inputStrokes.forwardGestureStart(client, args, timeoutMs, admission);
  }
  liftSessionlessStrokesOn(deviceId: string): void {
    return this.inputStrokes.liftSessionlessStrokesOn(deviceId);
  }
  liftStrokesHeldByOn(sessionId: string, deviceId: string): void {
    return this.inputStrokes.liftStrokesHeldByOn(sessionId, deviceId);
  }
  liftStrokesHeldBy(releasedSessionId: string): Promise<void> {
    return this.inputStrokes.liftStrokesHeldBy(releasedSessionId);
  }
  cancelGestureOnDevice(targetDevice: BootedDevice, gestureId: string): Promise<unknown> {
    return this.inputStrokes.cancelGestureOnDevice(targetDevice, gestureId);
  }
  forwardGestureFrame(
    client: AndroidCtrlProxy,
    kind: "start" | "move" | "end",
    args: {
      gestureId: string;
      x: number;
      y: number;
      cancel: boolean;
    },
    timeoutMs: number,
  ) {
    return this.inputStrokes.forwardGestureFrame(client, kind, args, timeoutMs);
  }
  async handleInputPressButton(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const args = this.callbacks.parseInputPressButtonParams(request.params);
    const { targetDevice, result: buttonResult } = await this.callbacks.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: "input/pressButton",
        origin: "UnixSocketServer.handleInputPressButton",
        args,
        checksFrame: true,
        dispatch: async ({
          targetDevice,
          signal,
          dispatching,
          remainingTimeoutMs,
          queueEnterMs,
          totalTimeoutMs,
        }) => {
          // Forward the execution tracker's abort signal (this bound-session path
          // is NOT wrapped in runWithAbortSignal, so there is no ambient signal for
          // press to pick up): without it, session teardown mid-home-press leaves
          // the ADB dispatch and foreground-verification reads running (issue #6289).
          const pressButton = new PressButton(targetDevice, null, this.state.timer, {
            holdRequest: (signal, _timeoutMs, send, onDispatch) =>
              this.callbacks.holdDispatchedInputRequest(
                signal,
                queueEnterMs + totalTimeoutMs - this.state.timer.now(),
                send,
                onDispatch,
                "Button press request",
              ),
          });
          return await pressButton.press(args.button, {
            timeoutMs: remainingTimeoutMs,
            frameContext: args.frameContext,
            signal,
            onDispatch: dispatching,
          });
        },
      },
    );
    if (!buttonResult.success) {
      throw new Error(buttonResult.error ?? `input/pressButton failed on ${args.platform}`);
    }
    return {
      action: "input/pressButton",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      button: args.responseButton,
    };
  }
  async handleInputKey(
    request: DaemonRequest,
    socketSessionId?: string,
    input?: InputRequestContext,
  ): Promise<any | undefined> {
    const args = this.callbacks.parseInputKeyParams(request.params);
    if (args.platform === "ios") {
      throw new Error(INPUT_KEY_IOS_UNSUPPORTED_ERROR);
    }
    const { targetDevice, result: keyResult } = await this.callbacks.runInputRoute(
      request,
      socketSessionId,
      input,
      {
        action: "input/key",
        origin: "UnixSocketServer.handleInputKey",
        args,
        checksFrame: true,
        dispatch: async ({
          targetDevice,
          signal,
          dispatching,
          remainingTimeoutMs,
          queueEnterMs,
          totalTimeoutMs,
        }) => {
          return await this.callbacks.executeSocketInputKey(
            new InputKey(targetDevice, {
              adbFactory: defaultAdbClientFactory,
              timer: this.state.timer,
            }),
            {
              key: args.key,
              frameContext: args.frameContext,
              totalTimeoutMs,
              remainingTimeoutMs,
              signal,
              dispatching,
            },
          );
        },
      },
    );
    if (!keyResult.success) {
      throw new Error(keyResult.error ?? `input/key failed on ${args.platform}`);
    }
    return {
      action: "input/key",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      key: args.key,
    };
  }
  /** A key has one write: its final beforeDispatch hook latches with no proxy await after it. */
  executeSocketInputKey(
    inputKey: InputKey,
    options: {
      key: InputKeyName;
      frameContext?: string;
      totalTimeoutMs: number;
      remainingTimeoutMs: number;
      signal?: AbortSignal;
      dispatching?: () => void;
    },
  ) {
    const { key, frameContext, totalTimeoutMs, remainingTimeoutMs, signal, dispatching } = options;
    let dispatched = false;
    const send = (fenced: AbortSignal | undefined, onDispatch: () => void) =>
      inputKey.press(key, remainingTimeoutMs, frameContext, {
        modifiers: [],
        signal: fenced,
        onDispatch,
      });
    return this.callbacks.runHeldInputOperation(
      "input/key",
      signal,
      (_signal, dispatch) =>
        this.callbacks.runInputOperationWithTimeout(
          {
            toolName: "input/key",
            origin: "UnixSocketServer.handleInputKey",
            totalTimeoutMs,
            remainingTimeoutMs,
          },
          () =>
            this.callbacks.holdDispatchedInputRequest(
              signal,
              remainingTimeoutMs,
              send,
              () => {
                dispatched = true;
                dispatch?.();
              },
              "Key request",
            ),
          (timeoutError) => (dispatched ? InputKey.indeterminateError(timeoutError) : undefined),
        ),
      () => dispatching?.(),
    );
  }
  private inputStrokesInstance?: InputStrokes;
  /** Resolve lazily after the shared callback table has been wired. */
  private get inputStrokes(): InputStrokes {
    return (this.inputStrokesInstance ??= new InputStrokes({
      parseInputGestureParams: (...args) => this.callbacks.parseInputGestureParams(...args),
      runInputRoute: (...args) => this.callbacks.runInputRoute(...args),
      liftingStrokeOnSessionRefusal: (...args) =>
        this.callbacks.liftingStrokeOnSessionRefusal(...args),
      forwardGestureFrame: (...args) => this.callbacks.forwardGestureFrame(...args),
      captureStrokeAdmission: (...args) => this.callbacks.captureStrokeAdmission(...args),
      forwardGestureStart: (...args) => this.callbacks.forwardGestureStart(...args),
      trackAckedGestureFrame: (...args) => this.callbacks.trackAckedGestureFrame(...args),
      ownedGestures: () => this.state.ownedGestures,
      strokeAdmissionStillHolds: (...args) => this.callbacks.strokeAdmissionStillHolds(...args),
      cancelGestureOnDevice: (...args) => this.callbacks.cancelGestureOnDevice(...args),
      getSessionForDevice: (...args) => this.callbacks.getSessionForDevice(...args),
      getSessionIncarnation: (...args) => this.callbacks.getSessionIncarnation(...args),
      trackRequestHandler: (...args) => this.callbacks.trackRequestHandler(...args),
      runKeyedMcpForward: (...args) => this.callbacks.runKeyedMcpForward(...args),
    }));
  }
}
