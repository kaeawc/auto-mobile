import {
  ActionableError,
  type BootedDevice,
  type DragPathOptions,
  type DragPathResult,
  type ObserveResult,
  unsupportedPlatformError,
} from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { type IdGenerator, NodeIdGenerator } from "../../utils/IdGenerator";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { throwIfAborted } from "../../utils/toolUtils";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { layerGestureRefusal } from "../observe/hierarchyLayer";
import { isAdoptableCapture } from "../observe/isAdoptableCapture";
import { snapshotReferences, type SnapshotReferenceStore } from "../observe/SnapshotReferenceStore";
import {
  BaseVisualChange,
  type DisplayFenceDependencies,
  type ProgressCallback,
} from "./BaseVisualChange";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "./TargetDisplayAction";
import type { ActionCall } from "./ActionCall";
import { supportsCtrlProxyGestureDisplay } from "./touchscreenInput";
import { resolveGestureCtrlProxyTimeoutMs } from "./gestureTransportTimeout";
import {
  assertDragPathFitsRequestBudget,
  dragPathTimeline,
  type DragPathPlan,
  planDragPath,
  resolveDragPathPoints,
} from "./dragPathPlan";
import { runDragPathStroke, type StrokeClient } from "./dragPathStroke";
import { instrumentationTimeoutMs } from "./pointer/instrumentationDispatch";
import { dispatchRichStylus, strokeRequest, type RichStylusOptions } from "./pointer/richStylus";
import { DRAG_PATH_DEFAULT_SEGMENT_MS } from "./dragPathPlan";
import { isStaleFrameContextRejection } from "./tapAtGesture";
import { StaleDisplayError, withStaleDisplay } from "../observe/StaleDisplayError";

export interface DragPathDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  androidClient?: StrokeClient & { supportsCommand?: (name: string) => Promise<boolean> };
  iosClient?: IosPathClient;
  idGenerator?: IdGenerator;
  lastRenderedObservation?: RenderedObservationReader;
  snapshotReferences?: SnapshotReferenceStore;
  /** Stylus routes and device facts; the defaults use instrumentation or root-only uinput and live device facts. */
  stylus?: Pick<RichStylusOptions, "injectors" | "readEnvironment">;
}

/** The iOS runner follows a whole timed path in one request. */
export type IosPathClient = Pick<IOSCtrlProxyClient, "requestPathGesture">;
type IosPathReply = Awaited<ReturnType<IosPathClient["requestPathGesture"]>>;

function canRefreshIosFrame(result: IosPathReply, frameContext: string | undefined): boolean {
  return (
    !result.success &&
    frameContext !== undefined &&
    !(result.dispatched === true && result.acknowledged !== true) &&
    isStaleFrameContextRejection(result.error)
  );
}

function failure(error: string): DragPathResult {
  return { success: false, error };
}

/** Attach `staleDisplay` details to an in-stroke failure while keeping its stroke-state note. */
function withStaleDetails(result: DragPathResult, error: unknown): DragPathResult {
  return { ...withStaleDisplay(result, error), error: result.error };
}

/** Drag one finger along a polyline using the CtrlProxy streaming stroke protocol (Android). */
export class DragPath extends BaseVisualChange {
  private readonly androidClientOverride?: StrokeClient & {
    supportsCommand?: (name: string) => Promise<boolean>;
  };
  private readonly iosClientOverride?: IosPathClient;
  private readonly idGenerator: IdGenerator;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private readonly snapshotReferences: SnapshotReferenceStore;
  private readonly stylusRoutes: Pick<RichStylusOptions, "injectors" | "readEnvironment">;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: DragPathDependencies = {},
  ) {
    super(device, {
      adb,
      timer: dependencies.timer,
      displayFence: dependencies,
    });
    this.androidClientOverride = dependencies.androidClient;
    this.iosClientOverride = dependencies.iosClient;
    this.idGenerator = dependencies.idGenerator ?? new NodeIdGenerator();
    this.lastRenderedObservation = dependencies.lastRenderedObservation;
    this.snapshotReferences = dependencies.snapshotReferences ?? snapshotReferences;
    this.stylusRoutes = dependencies.stylus ?? {};
  }

  private get androidClient() {
    return (
      this.androidClientOverride ?? AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory)
    );
  }

  private get iosClient(): IosPathClient {
    return this.iosClientOverride ?? IOSCtrlProxyClient.getInstance(this.device);
  }

  async execute(
    options: DragPathOptions,
    call: ActionCall & { progress?: ProgressCallback } = {},
  ): Promise<DragPathResult> {
    const { signal, progress } = call;
    if (this.device.platform !== "android" && this.device.platform !== "ios") {
      throw unsupportedPlatformError(this.device.platform, "dragPath");
    }
    const stylusRefusal = this.stylusRefusal(options);
    if (stylusRefusal) {
      return failure(stylusRefusal);
    }
    const perf = createGlobalPerformanceTracker();
    perf.serial("dragPath");
    try {
      throwIfAborted(signal);
      if (options.display !== undefined) {
        const { observation, displayId, assertCurrent } = await prepareTargetDisplayAction(
          this.device,
          options.display,
          this.observeScreen,
          {
            adb: this.adb,
            lastRenderedObservation: this.lastRenderedObservation,
            signal,
            transitions: this.displayTransitionReader,
          },
        );
        return await this.observedInteraction(
          () => this.drive(options, observation, call, { displayId, assertCurrent }),
          {
            changeExpected: false,
            display: observation.display.key,
            previousObservation: observation,
            signal,
            progress,
            perf,
          },
        );
      }
      return await this.observedInteraction(
        (observation, fence) =>
          this.drive(options, observation, call, {
            assertCurrent: fence && (() => fence.assertCurrent()),
          }),
        {
          changeExpected: false,
          progress,
          perf,
          signal,
          // Names the call a coordinate action, so the base refuses a posture or display change
          // since the caller's observe exactly as it does for tapAt (#17752).
          predictionContext: {
            toolName: "dragPath",
            toolArgs: { ...options, platform: this.device.platform },
          },
        },
      );
    } catch (error) {
      if (error instanceof StaleDisplayError) {
        // Same typed refusal as tapAt: the canonical message plus `staleDisplay` details.
        logger.warn(`[dragPath] refused after a display change: ${error.message}`);
        return withStaleDisplay(failure(error.message), error);
      }
      throw error;
    } finally {
      perf.end();
    }
  }

  /** Resolve points and plan the stroke, or return the refusal before any input. */
  private preparePlan(
    options: DragPathOptions,
    observation: ObserveResult,
    call: ActionCall,
  ): { plan: DragPathPlan } | { refusal: DragPathResult } {
    const stale = options.snapshotId
      ? this.snapshotReferences.staleReason(options.snapshotId, this.device.deviceId, observation)
      : undefined;
    if (stale) {
      return { refusal: failure(stale) };
    }
    const resolved = resolveDragPathPoints(options, observation, this.device.platform);
    if ("error" in resolved) {
      return { refusal: failure(resolved.error) };
    }
    const layerRefusal = layerGestureRefusal(
      observation.viewHierarchy,
      options.layer,
      resolved.points,
      "drag",
    );
    if (layerRefusal) {
      return { refusal: failure(layerRefusal) };
    }
    const plan = planDragPath(resolved.points, options);
    assertDragPathFitsRequestBudget(
      plan.totalMs,
      call.deadlineMs === undefined ? undefined : call.deadlineMs - this.timer.now(),
    );
    return { plan };
  }

  private async drive(
    options: DragPathOptions,
    observation: ObserveResult,
    call: ActionCall,
    { displayId, assertCurrent }: { displayId?: number; assertCurrent?: () => void },
  ): Promise<DragPathResult> {
    const prepared = this.preparePlan(options, observation, call);
    if ("refusal" in prepared) {
      return prepared.refusal;
    }
    const { plan } = prepared;
    if (options.pointer) {
      return this.driveStylus(options, plan, call, { displayId, assertCurrent });
    }
    if (this.device.platform === "ios") {
      return this.driveIos(options, plan, observation, { ...call, displayId, assertCurrent });
    }
    if (!(await supportsCtrlProxyGestureDisplay(this.androidClient, displayId))) {
      throw new ActionableError(
        "dragPath on a non-default display needs a CtrlProxy that advertises gesture_display_id_v1; update CtrlProxy or target the default display.",
      );
    }
    let stroke;
    try {
      stroke = await runDragPathStroke(this.androidClient, plan, {
        gestureId: this.idGenerator.next(),
        timer: this.timer,
        signal: call.signal,
        displayId,
        assertCurrent,
      });
    } catch (error) {
      if (call.signal?.aborted) {
        throw error;
      }
      logger.warn(`[dragPath] stroke failed: ${errorMessage(error)}`, error);
      return withStaleDetails(
        {
          success: false,
          points: plan.vertices,
          error: `dragPath failed: ${errorMessage(error)}. The finger was lifted; verify state with observe before retrying.`,
        },
        error,
      );
    }
    if (!stroke.success) {
      const note = stroke.indeterminate
        ? " The stroke may have partially run; verify state with observe before retrying."
        : "";
      return {
        success: false,
        points: plan.vertices,
        moveCount: stroke.moveCount,
        error: `dragPath failed: ${stroke.error}.${note}`,
      };
    }
    return {
      success: true,
      points: plan.vertices,
      plannedDurationMs: plan.totalMs,
      moveCount: stroke.moveCount,
    };
  }

  /** Refusals that need no device facts, so they come before any observation: nothing was sent. */
  private stylusRefusal(options: DragPathOptions): string | undefined {
    if (!options.pointer) {
      return undefined;
    }
    if (this.device.platform !== "android") {
      return 'dragPath with pointer: { toolType: "stylus" } is Android-only. No input was sent.';
    }
    return options.display === undefined
      ? undefined
      : "dragPath with a stylus drives the default display only; omit display. No input was sent.";
  }

  /**
   * A stylus path through instrumentation or root-only uinput (#13099, #13084): the plan's vertices become waypoints with
   * the authored per-point pressure and tilt, and the holds become repeats of the first and last point.
   * Refused before any input when the device lacks the route; never a finger.
   */
  private async driveStylus(
    options: DragPathOptions,
    plan: DragPathPlan,
    call: ActionCall,
    { displayId, assertCurrent }: { displayId?: number; assertCurrent?: () => void },
  ): Promise<DragPathResult> {
    // Slow injection, cold start and teardown count against the request budget too.
    assertDragPathFitsRequestBudget(
      plan.totalMs,
      call.deadlineMs === undefined ? undefined : call.deadlineMs - this.timer.now(),
      instrumentationTimeoutMs(plan.totalMs) - plan.totalMs,
    );
    const authored = options.points;
    const waypoints = plan.vertices.map((vertex, index) => ({
      ...vertex,
      durationMs:
        index === 0 ? undefined : (authored[index]?.durationMs ?? DRAG_PATH_DEFAULT_SEGMENT_MS),
      pressure: authored[index]?.pressure,
      tilt: authored[index]?.tilt,
    }));
    const first = waypoints[0];
    const last = waypoints[waypoints.length - 1];
    if (plan.holdMs > 0) {
      waypoints.splice(1, 0, { ...first, durationMs: plan.holdMs });
    }
    if (plan.releaseHoldMs > 0) {
      waypoints.push({ ...last, durationMs: plan.releaseHoldMs });
    }
    try {
      await dispatchRichStylus(
        this.device,
        this.adb,
        strokeRequest(options.pointer!, waypoints, { path: true }),
        {
          ...this.stylusRoutes,
          signal: call.signal,
          assertCurrent,
        },
      );
    } catch (error) {
      if (call.signal?.aborted) {
        throw error;
      }
      logger.warn(`[dragPath] stylus stroke failed: ${errorMessage(error)}`, error);
      return withStaleDetails(
        { success: false, points: plan.vertices, error: `dragPath failed: ${errorMessage(error)}` },
        error,
      );
    }
    return {
      success: true,
      points: plan.vertices,
      plannedDurationMs: plan.totalMs,
      moveCount: waypoints.length - 1,
    };
  }

  private async driveIos(
    options: DragPathOptions,
    plan: DragPathPlan,
    observation: ObserveResult,
    call: ActionCall & { displayId?: number; assertCurrent?: () => void },
  ): Promise<DragPathResult> {
    const { displayId, assertCurrent } = call;
    if (displayId !== undefined && displayId !== 0) {
      throw new ActionableError(
        "dragPath on iOS drives the observed active display; target the default display.",
      );
    }
    const timeline = dragPathTimeline(plan);
    const dispatch = async (frameContext: string | undefined) => {
      throwIfAborted(call.signal);
      assertCurrent?.();
      const result = await this.iosClient.requestPathGesture(
        timeline,
        resolveGestureCtrlProxyTimeoutMs(plan.totalMs),
        { frameContext, signal: call.signal },
      );
      throwIfAborted(call.signal);
      return result;
    };
    const frameContext = observation.viewHierarchy?.frameContext;
    let result = await dispatch(frameContext);
    if (canRefreshIosFrame(result, frameContext)) {
      const retry = await this.refreshIosFrame(options, plan, observation, call);
      if ("refusal" in retry) {
        return retry.refusal;
      }
      // No loop: even a fresh iOS capture can repeat a semantic token; a second rejection surfaces.
      result = await dispatch(retry.frameContext);
    }
    if (!result.success) {
      const note =
        result.dispatched === true && result.acknowledged !== true
          ? " The stroke was sent but never confirmed and may have run; verify state with observe before retrying."
          : "";
      return {
        success: false,
        points: plan.vertices,
        error: `dragPath failed: ${result.error ?? "unknown error"}.${note}`,
      };
    }
    return {
      success: true,
      points: plan.vertices,
      plannedDurationMs: plan.totalMs,
      moveCount: plan.moves.length,
    };
  }

  private async refreshIosFrame(
    options: DragPathOptions,
    plan: DragPathPlan,
    observation: ObserveResult,
    call: ActionCall & { assertCurrent?: () => void },
  ): Promise<{ frameContext: string } | { refusal: DragPathResult }> {
    // The runner refused before input. A previous drag can leave the cached frame behind
    // scrolling content, so refresh and re-resolve the points without requiring equal layouts.
    call.assertCurrent?.();
    const refreshed = await this.observeScreen.execute({
      display: observation.display.key,
      freshness: "fresh",
      signal: call.signal,
    });
    throwIfAborted(call.signal);
    call.assertCurrent?.();
    const prepared = this.preparePlan(options, refreshed, call);
    if ("refusal" in prepared) {
      return prepared;
    }
    if (
      prepared.plan.vertices.some(
        (point, index) => point.x !== plan.vertices[index].x || point.y !== plan.vertices[index].y,
      )
    ) {
      return {
        refusal: failure(
          "Stale frame context: dragPath points changed since the last observation. Observe again and recompute points, or pass a fresh snapshotId.",
        ),
      };
    }
    const frameContext = refreshed.viewHierarchy?.frameContext;
    return frameContext && isAdoptableCapture(observation, refreshed, true)
      ? { frameContext }
      : {
          refusal: failure(
            "Stale frame context: a fresh frame is unavailable. Observe again before retrying dragPath.",
          ),
        };
  }
}
