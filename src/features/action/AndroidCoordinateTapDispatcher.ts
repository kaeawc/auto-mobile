import type { ObserveResult, TapAtOptions } from "../../models";
import { toActionableError } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import type { AndroidCoordinateTalkBack } from "./AndroidCoordinateTalkBack";
import { awaitSecondTapSlot, tryAtomicAndroidDoubleTap } from "./androidDoubleTap";
import {
  type CoordinateTapClient,
  dispatchAndroidCoordinateTap,
  isStaleFrameContextRejection,
} from "./coordinateTapDispatch";
import { tapDurationMs } from "./tapAtGesture";
import { tapDeliveryReporter } from "./tapSharedHelpers";

/** Live action capabilities shared with the iOS and display dispatch paths. */
export interface AndroidCoordinateTapDispatcherHost {
  readonly adb: AdbExecutor;
  readonly observeScreen: Pick<ObserveScreen, "execute">;
  assertDisplayRevisionCurrent(fence: { revision: number; observedGeneration: number }): void;
  assertSnapshotCurrent(options: TapAtOptions, observation: ObserveResult): void;
  resolveFreshFrameRetry(
    options: TapAtOptions,
    point: { x: number; y: number },
    initial: ObserveResult,
    refreshed: ObserveResult,
  ): { point: { x: number; y: number }; frameContext: string } | undefined;
  retryFreshness(options: TapAtOptions): "fresh" | "cached-ok";
}

interface AndroidCoordinateTapDispatcherDependencies {
  host: AndroidCoordinateTapDispatcherHost;
  androidClient: CoordinateTapClient;
  androidCoordinateTap: typeof dispatchAndroidCoordinateTap;
  androidTalkBack: Pick<AndroidCoordinateTalkBack, "dispatchTap">;
  timer: Timer;
}

/** Outcome of the first Android tap: whether a single-gesture double tap already finished. */
type AndroidFirstTap = { doubleTapDelivered: boolean; startedAt: number };

/** Android coordinate delivery, including one safe frame retry and double-tap timing. */
export class AndroidCoordinateTapDispatcher {
  constructor(private readonly dependencies: AndroidCoordinateTapDispatcherDependencies) {}

  /** The first Android tap (with its fresh-frame retry), then the second tap of a doubleTap. */
  async dispatchAndroidTaps(
    options: TapAtOptions,
    resolved: { x: number; y: number },
    observeResult: ObserveResult,
    transitionRevision: { revision: number; observedGeneration: number },
    perf: PerformanceTracker,
    context: {
      signal?: AbortSignal;
      onTapDelivered: () => void;
      talkBackEnabled: boolean;
      onActivationWarnings: (warnings?: string[]) => void;
    },
  ): Promise<void> {
    const firstTap = await this.dispatchAndroidTapWithOneFreshRetry(
      options,
      resolved,
      observeResult,
      transitionRevision,
      perf,
      context,
    );
    if (!context.talkBackEnabled) {
      await this.dispatchSecondAndroidTap(options, resolved, transitionRevision, {
        ...context,
        firstTap,
      });
    }
  }

  private async dispatchAndroidTapWithOneFreshRetry(
    options: TapAtOptions,
    resolved: { x: number; y: number },
    observeResult: ObserveResult,
    transitionRevision: { revision: number; observedGeneration: number },
    perf: PerformanceTracker,
    context: {
      signal?: AbortSignal;
      onTapDelivered: () => void;
      talkBackEnabled: boolean;
      onActivationWarnings: (warnings?: string[]) => void;
    },
  ): Promise<AndroidFirstTap> {
    const { signal } = context;
    const frameContext = observeResult.viewHierarchy?.frameContext;
    let delivered = false;
    let talkBackDispatched = false;
    const onTapDelivered = () => {
      delivered = true;
      context.onTapDelivered();
    };
    try {
      if (context.talkBackEnabled) {
        await this.dependencies.androidTalkBack.dispatchTap(
          options,
          resolved,
          frameContext,
          signal,
          {
            assertCurrent: () =>
              this.dependencies.host.assertDisplayRevisionCurrent(transitionRevision),
            onTapDelivered,
            onDispatched: () => {
              talkBackDispatched = true;
            },
            onActivationWarnings: context.onActivationWarnings,
          },
        );
        return { doubleTapDelivered: false, startedAt: this.dependencies.timer.now() };
      }
      return await this.dispatchAndroidFirstTap(options, resolved, frameContext, signal, {
        assertCurrent: () =>
          this.dependencies.host.assertDisplayRevisionCurrent(transitionRevision),
        onTapDelivered: context.onTapDelivered,
      });
    } catch (error) {
      // Cancellation must escape before stale-frame classification or retry.
      throwIfAborted(signal);
      const actionable = toActionableError(error, "Failed to dispatch Android coordinate tap");
      if (
        delivered ||
        talkBackDispatched ||
        frameContext === undefined ||
        !isStaleFrameContextRejection(actionable.message)
      ) {
        throw actionable;
      }

      // One re-observation distinguishes Android's benign generation churn from a layout-invalidating
      // advance. Any unprovable or changed targeting state still fails closed.
      throwIfAborted(signal);
      const refreshedObservation = await this.dependencies.host.observeScreen.execute({
        freshness: this.dependencies.host.retryFreshness(options),
        signal,
        perf,
      });
      this.dependencies.host.assertDisplayRevisionCurrent(transitionRevision);
      this.dependencies.host.assertSnapshotCurrent(options, refreshedObservation);
      const retry = this.dependencies.host.resolveFreshFrameRetry(
        options,
        resolved,
        observeResult,
        refreshedObservation,
      );
      if (!retry) {
        throw actionable;
      }

      // Deliberately no loop: if this single retry also races a frame advance, its actionable stale
      // rejection escapes and the caller can choose a new point from another explicit observation.
      if (context.talkBackEnabled) {
        await this.dependencies.androidTalkBack.dispatchTap(
          options,
          retry.point,
          retry.frameContext,
          signal,
          {
            assertCurrent: () =>
              this.dependencies.host.assertDisplayRevisionCurrent(transitionRevision),
            onTapDelivered,
            onDispatched: () => {
              talkBackDispatched = true;
            },
            onActivationWarnings: context.onActivationWarnings,
          },
        );
        return { doubleTapDelivered: false, startedAt: this.dependencies.timer.now() };
      }
      return await this.dispatchAndroidFirstTap(options, retry.point, retry.frameContext, signal, {
        assertCurrent: () =>
          this.dependencies.host.assertDisplayRevisionCurrent(transitionRevision),
        onTapDelivered: context.onTapDelivered,
      });
    }
  }

  /**
   * First Android tap of the action. A doubleTap is sent as one device-timed gesture when the
   * runner supports it; otherwise only the first tap is sent and the caller schedules the second
   * from the returned start time.
   */
  private async dispatchAndroidFirstTap(
    options: TapAtOptions,
    point: { x: number; y: number },
    frameContext: string | undefined,
    signal: AbortSignal | undefined,
    context: { assertCurrent: () => void; onTapDelivered: () => void },
  ): Promise<AndroidFirstTap> {
    const startedAt = this.dependencies.timer.now();
    if (
      options.action === "doubleTap" &&
      (await tryAtomicAndroidDoubleTap(this.dependencies.androidClient, {
        ...point,
        frameContext,
        signal,
        assertCurrent: context.assertCurrent,
        onTapDelivered: context.onTapDelivered,
      }))
    ) {
      return { doubleTapDelivered: true, startedAt };
    }
    await this.dispatchAndroidTap(
      point,
      tapDurationMs(options, "android"),
      frameContext,
      signal,
      context,
    );
    return { doubleTapDelivered: false, startedAt };
  }

  private async dispatchSecondAndroidTap(
    options: TapAtOptions,
    point: { x: number; y: number },
    revision: { revision: number; observedGeneration: number },
    context: {
      signal?: AbortSignal;
      onTapDelivered: () => void;
      firstTap: AndroidFirstTap;
      onActivationWarnings: (warnings?: string[]) => void;
    },
  ): Promise<void> {
    const { signal } = context;
    if (options.action !== "doubleTap" || context.firstTap.doubleTapDelivered) {
      return;
    }
    // The gap is measured from the first tap's start, not its (slow) reply.
    await awaitSecondTapSlot(this.dependencies.timer, context.firstTap.startedAt, {
      signal,
      onWarning: (warning) => context.onActivationWarnings([warning]),
    });
    this.dependencies.host.assertDisplayRevisionCurrent(revision);
    await this.dispatchAndroidTap(
      point,
      tapDurationMs(options, "android"),
      // The accepted first tap fixed the point for this gesture; it may have advanced the frame.
      undefined,
      signal,
      {
        assertCurrent: () => this.dependencies.host.assertDisplayRevisionCurrent(revision),
        onTapDelivered: context.onTapDelivered,
      },
    );
  }

  private async dispatchAndroidTap(
    point: { x: number; y: number },
    duration: number,
    frameContext: string | undefined,
    signal: AbortSignal | undefined,
    context: { assertCurrent: () => void; onTapDelivered: () => void },
  ): Promise<void> {
    const reportDelivery = tapDeliveryReporter(context.onTapDelivered);
    await this.dependencies.androidCoordinateTap(
      this.dependencies.androidClient,
      this.dependencies.host.adb,
      point.x,
      point.y,
      duration,
      {
        frameContext,
        signal,
        assertCurrent: context.assertCurrent,
        onTapDelivered: reportDelivery,
      },
    );
    // Legacy injected dispatchers confirm delivery by returning, without invoking the new hook.
    reportDelivery();
    throwIfAborted(signal);
  }
}
