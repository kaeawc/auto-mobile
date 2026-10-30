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
import { INSTRUMENTATION_OVERHEAD_MS } from "./pointer/instrumentationDispatch";
import { dispatchRichStylus, strokeRequest, type RichStylusOptions } from "./pointer/richStylus";
import { DRAG_PATH_DEFAULT_SEGMENT_MS } from "./dragPathPlan";

export interface DragPathDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  androidClient?: StrokeClient & { supportsCommand?: (name: string) => Promise<boolean> };
  iosClient?: IosPathClient;
  idGenerator?: IdGenerator;
  lastRenderedObservation?: RenderedObservationReader;
  snapshotReferences?: SnapshotReferenceStore;
  /** Stylus routes and device facts; the defaults use the instrumentation route and the live device. */
  stylus?: Pick<RichStylusOptions, "injectors" | "readEnvironment">;
}

/** The iOS runner follows a whole timed path in one request. */
export type IosPathClient = Pick<IOSCtrlProxyClient, "requestPathGesture">;

function failure(error: string): DragPathResult {
  return { success: false, error };
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
        { changeExpected: false, progress, perf, signal },
      );
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
      return this.driveIos(plan, observation, call, { displayId, assertCurrent });
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
      return {
        success: false,
        points: plan.vertices,
        error: `dragPath failed: ${errorMessage(error)}. The finger was lifted; verify state with observe before retrying.`,
      };
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
   * A stylus path through the instrumentation route (#13099): the plan's vertices become waypoints with
   * the authored per-point pressure and tilt, and the holds become repeats of the first and last point.
   * Refused before any input when the device lacks the route; never a finger.
   */
  private async driveStylus(
    options: DragPathOptions,
    plan: DragPathPlan,
    call: ActionCall,
    { displayId, assertCurrent }: { displayId?: number; assertCurrent?: () => void },
  ): Promise<DragPathResult> {
    // Cold start and teardown of the instrumentation count against the request budget too.
    assertDragPathFitsRequestBudget(
      plan.totalMs + INSTRUMENTATION_OVERHEAD_MS,
      call.deadlineMs === undefined ? undefined : call.deadlineMs - this.timer.now(),
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
      return {
        success: false,
        points: plan.vertices,
        error: `dragPath failed: ${errorMessage(error)}`,
      };
    }
    return {
      success: true,
      points: plan.vertices,
      plannedDurationMs: plan.totalMs,
      moveCount: waypoints.length - 1,
    };
  }

  private async driveIos(
    plan: DragPathPlan,
    observation: ObserveResult,
    call: ActionCall,
    { displayId, assertCurrent }: { displayId?: number; assertCurrent?: () => void },
  ): Promise<DragPathResult> {
    if (displayId !== undefined && displayId !== 0) {
      throw new ActionableError(
        "dragPath on iOS drives the main display only; target the default display.",
      );
    }
    throwIfAborted(call.signal);
    assertCurrent?.();
    const timeline = dragPathTimeline(plan);
    const result = await this.iosClient.requestPathGesture(
      timeline,
      resolveGestureCtrlProxyTimeoutMs(plan.totalMs),
      observation.viewHierarchy?.frameContext,
      call.signal,
    );
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
}
