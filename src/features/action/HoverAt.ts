import {
  ActionableError,
  type BootedDevice,
  type HoverAtOptions,
  type HoverAtResult,
  type ObserveResult,
} from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import type { Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { throwIfAborted } from "../../utils/toolUtils";
import { AndroidCtrlProxyClient } from "../observe/android";
import {
  HOVER_INPUT_CAPABILITY,
  STYLUS_INPUT_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol/capabilities";
import { layerGestureRefusal } from "../observe/hierarchyLayer";
import { snapshotReferences, type SnapshotReferenceStore } from "../observe/SnapshotReferenceStore";
import {
  BaseVisualChange,
  type DisplayFenceDependencies,
  type ProgressCallback,
} from "./BaseVisualChange";
import { prepareTargetDisplayAction, type RenderedObservationReader } from "./TargetDisplayAction";
import type { ActionCall } from "./ActionCall";
import { resolveTapAtCoordinates } from "./TapAtCoordinate";
import { DRAG_PATH_DEFAULT_SEGMENT_MS, assertDragPathFitsRequestBudget } from "./dragPathPlan";
import type { PointerEnvironment, PointerInjector } from "./pointer/PointerInjector";
import { createInstrumentationDispatch } from "./pointer/instrumentationDispatch";
import { defaultPointerRoutes } from "./pointer/pointerRoutes";
import { pointerCapabilities, selectPointerRoute } from "./pointer/selectPointerRoute";

const API_READ_TIMEOUT_MS = 5000;

export interface HoverAtDependencies extends DisplayFenceDependencies {
  timer?: Timer;
  /** Routes in preference order; the default list injects hover through the CtrlProxy instrumentation. */
  pointerInjectors?: readonly PointerInjector[];
  /** The device facts the routes decide on; the default reads the API level and the runner flags. */
  readPointerEnvironment?: (signal?: AbortSignal) => Promise<PointerEnvironment>;
  lastRenderedObservation?: RenderedObservationReader;
  snapshotReferences?: SnapshotReferenceStore;
}

type HoverPoint = { x: number; y: number; durationMs?: number; distance?: number };

function failure(error: string): HoverAtResult {
  return { success: false, error };
}

/** Dispatch for a route a hover can never take (a finger route, the stylus shell route). */
async function notAHoverRoute(): Promise<void> {
  throw new ActionableError("This route cannot inject a hover.");
}

/**
 * Hover enter, move and exit over a path with a stylus or a mouse, no contact (Android). It is gated on
 * `hover_input_v1`: iOS and any runner that does not advertise it are refused before anything is sent,
 * and a hover is never turned into a touch.
 */
export class HoverAt extends BaseVisualChange {
  private readonly injectors: readonly PointerInjector[];
  private readonly readEnvironment: (signal?: AbortSignal) => Promise<PointerEnvironment>;
  private readonly lastRenderedObservation?: RenderedObservationReader;
  private readonly snapshotReferences: SnapshotReferenceStore;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    dependencies: HoverAtDependencies = {},
  ) {
    super(device, adb, dependencies.timer, dependencies.renderedDisplayRevision, dependencies);
    this.injectors =
      dependencies.pointerInjectors ??
      defaultPointerRoutes({
        a11y: notAHoverRoute,
        adbInputSource: notAHoverRoute,
        instrumentation: createInstrumentationDispatch(this.adb),
      });
    this.readEnvironment =
      dependencies.readPointerEnvironment ?? ((signal) => this.readDeviceEnvironment(signal));
    this.lastRenderedObservation = dependencies.lastRenderedObservation;
    this.snapshotReferences = dependencies.snapshotReferences ?? snapshotReferences;
  }

  /** Best effort: a runner that cannot be asked advertises nothing, which refuses the hover. */
  private async readDeviceEnvironment(signal?: AbortSignal): Promise<PointerEnvironment> {
    // An established runner connection only: with none, no capability is advertised and the hover is refused.
    const client = AndroidCtrlProxyClient.getExistingInstance(this.device.deviceId);
    const advertised = new Set<string>();
    try {
      for (const capability of [HOVER_INPUT_CAPABILITY, STYLUS_INPUT_CAPABILITY]) {
        if (client && (await client.supportsCommand(capability))) {
          advertised.add(capability);
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(
        `[hoverAt] could not read the runner's capabilities: ${errorMessage(error)}`,
        error,
      );
    }
    const apiLevel = await readAndroidDeviceApiLevel(
      this.adb,
      API_READ_TIMEOUT_MS,
      undefined,
      signal,
    ).catch((error: unknown) => {
      if (signal?.aborted) {
        throw error;
      }
      logger.warn(`[hoverAt] could not read the Android API level: ${errorMessage(error)}`, error);
      return null;
    });
    return {
      platform: "android",
      apiLevel: apiLevel ?? undefined,
      capabilities: pointerCapabilities((name) => advertised.has(name)),
    };
  }

  async execute(
    options: HoverAtOptions,
    call: ActionCall & { progress?: ProgressCallback } = {},
  ): Promise<HoverAtResult> {
    const { signal, progress } = call;
    if (this.device.platform !== "android") {
      return failure(
        "hoverAt is Android only: iOS has no public hover injection (a pointer hover needs a trackpad or Pencil). No input was sent.",
      );
    }
    throwIfAborted(signal);
    const features = { toolType: options.toolType ?? "stylus", hover: true } as const;
    const choice = selectPointerRoute(features, await this.readEnvironment(signal), this.injectors);
    if (choice.selected === null) {
      return failure(`hoverAt: ${choice.refusal} No input was sent.`);
    }
    const injector = choice.selected;
    const perf = createGlobalPerformanceTracker();
    perf.serial("hoverAt");
    try {
      if (options.display !== undefined) {
        const { observation, displayId, assertCurrent } = await prepareTargetDisplayAction(
          this.device,
          options.display,
          this.observeScreen,
          this.adb,
          {
            lastRenderedObservation: this.lastRenderedObservation,
            signal,
            transitions: this.displayTransitionReader,
          },
        );
        return await this.observedInteraction(
          () => this.drive(injector, options, observation, call, displayId, assertCurrent),
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
          this.drive(
            injector,
            options,
            observation,
            call,
            undefined,
            fence && (() => fence.assertCurrent()),
          ),
        { changeExpected: false, progress, perf, signal },
      );
    } finally {
      perf.end();
    }
  }

  /** Every requested point as a native in-bounds point, or the first failure. */
  private resolvePoints(
    options: HoverAtOptions,
    observation: ObserveResult,
  ): { points: HoverPoint[] } | { error: string } {
    const points: HoverPoint[] = [];
    for (const [index, point] of options.points.entries()) {
      const resolved = resolveTapAtCoordinates(
        { x: point.x, y: point.y, coordinateSpace: options.coordinateSpace },
        observation,
        this.device.platform,
        "hoverAt",
      );
      if ("error" in resolved) {
        return { error: `points[${index}]: ${resolved.error}` };
      }
      points.push({
        x: resolved.x,
        y: resolved.y,
        durationMs: index === 0 ? undefined : point.durationMs,
        distance: point.distance,
      });
    }
    return { points };
  }

  private async drive(
    injector: PointerInjector,
    options: HoverAtOptions,
    observation: ObserveResult,
    call: ActionCall,
    displayId: number | undefined,
    assertCurrent: (() => void) | undefined,
  ): Promise<HoverAtResult> {
    const stale = options.snapshotId
      ? this.snapshotReferences.staleReason(options.snapshotId, this.device.deviceId, observation)
      : undefined;
    if (stale) {
      return failure(stale);
    }
    const resolved = this.resolvePoints(options, observation);
    if ("error" in resolved) {
      return failure(resolved.error);
    }
    const { points } = resolved;
    const layerRefusal = layerGestureRefusal(
      observation.viewHierarchy,
      options.layer,
      points,
      "hover",
    );
    if (layerRefusal) {
      return failure(layerRefusal);
    }
    const plannedDurationMs = points
      .slice(1)
      .reduce((sum, point) => sum + (point.durationMs ?? DRAG_PATH_DEFAULT_SEGMENT_MS), 0);
    assertDragPathFitsRequestBudget(
      plannedDurationMs,
      call.deadlineMs === undefined ? undefined : call.deadlineMs - this.timer.now(),
    );
    throwIfAborted(call.signal);
    assertCurrent?.();
    try {
      await injector.inject(
        {
          features: { toolType: options.toolType ?? "stylus", hover: true },
          points,
          displayId,
        },
        call.signal,
      );
    } catch (error) {
      if (call.signal?.aborted) {
        throw error;
      }
      logger.warn(`[hoverAt] injection failed: ${errorMessage(error)}`, error);
      return {
        success: false,
        points: points.map(({ x, y }) => ({ x, y })),
        route: injector.route,
        error: `hoverAt failed: ${errorMessage(error)}. The hover may have partially run; verify state with observe before retrying.`,
      };
    }
    return {
      success: true,
      points: points.map(({ x, y }) => ({ x, y })),
      plannedDurationMs,
      route: injector.route,
    };
  }
}
