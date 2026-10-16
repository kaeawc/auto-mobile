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
import {
  assertDragPathFitsRequestBudget,
  planDragPath,
  resolveDragPathPoints,
} from "./dragPathPlan";
import { runDragPathStroke, type StrokeClient } from "./dragPathStroke";

export interface DragPathDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  androidClient?: StrokeClient & { supportsCommand?: (name: string) => Promise<boolean> };
  idGenerator?: IdGenerator;
  lastRenderedObservation?: RenderedObservationReader;
  snapshotReferences?: SnapshotReferenceStore;
}

function failure(error: string): DragPathResult {
  return { success: false, error };
}

/** Drag one finger along a polyline using the CtrlProxy streaming stroke protocol (Android). */
export class DragPath extends BaseVisualChange {
  private readonly androidClient: StrokeClient & {
    supportsCommand?: (name: string) => Promise<boolean>;
  };
  private readonly idGenerator: IdGenerator;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private readonly snapshotReferences: SnapshotReferenceStore;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: DragPathDependencies = {},
  ) {
    super(device, adb, dependencies.timer, dependencies.renderedDisplayRevision, dependencies);
    this.androidClient =
      dependencies.androidClient ?? AndroidCtrlProxyClient.getInstance(device, this.adbFactory);
    this.idGenerator = dependencies.idGenerator ?? new NodeIdGenerator();
    this.lastRenderedObservation = dependencies.lastRenderedObservation;
    this.snapshotReferences = dependencies.snapshotReferences ?? snapshotReferences;
  }

  async execute(
    options: DragPathOptions,
    call: ActionCall & { progress?: ProgressCallback } = {},
  ): Promise<DragPathResult> {
    const { signal, progress } = call;
    if (this.device.platform !== "android") {
      throw unsupportedPlatformError(
        this.device.platform,
        "dragPath (the iOS runner has no multi-segment stroke dispatch yet)",
      );
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

  private async drive(
    options: DragPathOptions,
    observation: ObserveResult,
    call: ActionCall,
    displayId: number | undefined,
    assertCurrent: (() => void) | undefined,
  ): Promise<DragPathResult> {
    const stale = options.snapshotId
      ? this.snapshotReferences.staleReason(options.snapshotId, this.device.deviceId, observation)
      : undefined;
    if (stale) {
      return failure(stale);
    }
    const resolved = resolveDragPathPoints(options, observation, this.device.platform);
    if ("error" in resolved) {
      return failure(resolved.error);
    }
    const layerRefusal = layerGestureRefusal(
      observation.viewHierarchy,
      options.layer,
      resolved.points,
      "drag",
    );
    if (layerRefusal) {
      return failure(layerRefusal);
    }
    const plan = planDragPath(resolved.points, options);
    assertDragPathFitsRequestBudget(
      plan.totalMs,
      call.deadlineMs === undefined ? undefined : call.deadlineMs - this.timer.now(),
    );
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
}
