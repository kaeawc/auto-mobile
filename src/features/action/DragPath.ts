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

export interface DragPathDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  androidClient?: StrokeClient & { supportsCommand?: (name: string) => Promise<boolean> };
  iosClient?: IosPathClient;
  idGenerator?: IdGenerator;
  lastRenderedObservation?: RenderedObservationReader;
  snapshotReferences?: SnapshotReferenceStore;
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

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: DragPathDependencies = {},
  ) {
    super(device, adb, dependencies.timer, dependencies.renderedDisplayRevision, dependencies);
    this.androidClientOverride = dependencies.androidClient;
    this.iosClientOverride = dependencies.iosClient;
    this.idGenerator = dependencies.idGenerator ?? new NodeIdGenerator();
    this.lastRenderedObservation = dependencies.lastRenderedObservation;
    this.snapshotReferences = dependencies.snapshotReferences ?? snapshotReferences;
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
    const perf = createGlobalPerformanceTracker();
    perf.serial("dragPath");
    try {
      throwIfAborted(signal);
      if (options.display !== undefined) {
        const { observation, displayId, assertCurrent } = await prepareTargetDisplayAction(
          this.device,
          options.display,
          this.observeScreen,
          this.adb,
          this.lastRenderedObservation,
          signal,
          this.displayTransitionReader,
        );
        return await this.observedInteraction(
          () => this.drive(options, observation, call, displayId, assertCurrent),
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
        (observation) => this.drive(options, observation, call, undefined, undefined),
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
    displayId: number | undefined,
    assertCurrent: (() => void) | undefined,
  ): Promise<DragPathResult> {
    const prepared = this.preparePlan(options, observation, call);
    if ("refusal" in prepared) {
      return prepared.refusal;
    }
    const { plan } = prepared;
    if (this.device.platform === "ios") {
      return this.driveIos(plan, observation, call, displayId, assertCurrent);
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

  private async driveIos(
    plan: DragPathPlan,
    observation: ObserveResult,
    call: ActionCall,
    displayId: number | undefined,
    assertCurrent: (() => void) | undefined,
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
