import type { BootedDevice, ObserveResult } from "../../models";
import { requireAndroidOrIosPlatform } from "../../models";
import type { DisplayObservation } from "../../models/ObserveResult";
import { logger } from "../../utils/logger";
import { errorMessage as describeError } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type { ObserveScreenExecuteOptions } from "./interfaces/ObserveScreen";
import type { ScreenshotEncodingOptions } from "./screenshot/screenshotOptions";
import type { ScreenshotPathProtection } from "./ScreenshotPathProtection";
import { publishScreenshotPaths } from "./ScreenshotRetention";
import { computeFreshness } from "./observationFreshness";
import { displayTransitions } from "./DisplayTransition";
import {
  assertAllDisplayObserveSupported,
  DisplaySelectionError,
  resolveTargetDisplay,
} from "./DisplaySelection";

/** Narrow seam over the owning observer: one single-display read plus result builders. */
export interface AllDisplaysObservationDependencies {
  device: () => BootedDevice;
  timer: () => Timer;
  pathProtection: () => ScreenshotPathProtection;
  executeSingleDisplay: (
    options: ObserveScreenExecuteOptions & { preserveDisplayState?: boolean },
  ) => Promise<ObserveResult>;
  captureDeviceReadScreenshot: (
    result: ObserveResult,
    signal: AbortSignal | undefined,
    options: ScreenshotEncodingOptions,
    scope: { display?: string },
  ) => Promise<void>;
  createCriticalFallback: (error: unknown) => ObserveResult;
  createBaseResult: () => ObserveResult;
}

/** `display: "all"` aggregation: one bounded read per physical panel under a shared deadline. */
export class AllDisplaysObservation {
  constructor(private readonly d: AllDisplaysObservationDependencies) {}

  async execute(
    options?: ObserveScreenExecuteOptions & { deviceReadScreenshot?: ScreenshotEncodingOptions },
  ): Promise<ObserveResult> {
    const deviceReadScreenshot = options?.deviceReadScreenshot;
    assertAllDisplayObserveSupported(
      requireAndroidOrIosPlatform(this.d.device().platform, "Observing all displays"),
    );
    // Reuse the existing hierarchy-capture budget; one deadline covers every panel.
    const deadline = this.d.timer().now() + (options?.timeoutMs ?? 15000);
    const active = await this.readAggregatePanel("active", {
      options,
      deadline,
      deviceReadScreenshot,
    });
    const panels = this.d.device().displays?.panels;
    if (!panels?.length) {
      // Discovery omits single-screen inventory: retain exactly the ordinary result.
      return active;
    }
    const activePanelKey = panels.some((panel) => panel.key === active.display.key)
      ? active.display.key
      : resolveTargetDisplay(this.d.device().displays, "active", {
          focusedPanelKey: displayTransitions.observedPanel(this.d.device().deviceId)?.key,
        }).key;
    const displays: DisplayObservation[] = [];
    for (const panel of panels) {
      const observation =
        panel.key === activePanelKey
          ? active
          : await this.readAggregatePanel(panel.key, {
              options: {
                ...options,
                // Extra screenshots would overwrite shared screenshot state. Only the
                // normal active capture supplies a path; extras are hierarchy reads.
                skipScreenshot: true,
                skipPerformanceAudit: true,
                skipAccessibilityAudit: true,
                skipRecompositionTracking: true,
              },
              deadline,
            });
      const {
        display,
        screenSize,
        viewHierarchy,
        elements,
        screenshotPath,
        screenshotExpiresAt,
        systemInsets,
        insets,
        activeWindow,
      } = observation;
      displays.push({
        display: { ...display, key: panel.key, role: panel.role },
        screenSize,
        viewHierarchy,
        elements,
        screenshotPath,
        screenshotExpiresAt,
        systemInsets,
        insets,
        activeWindow,
        freshness:
          observation.freshness ??
          computeFreshness({ now: this.d.timer().now(), unavailable: true }),
      });
    }
    const result = { ...active, displays };
    await publishScreenshotPaths(result, this.d.pathProtection());
    return result;
  }

  private async readAggregatePanel(
    display: string,
    request: {
      options?: ObserveScreenExecuteOptions;
      deadline: number;
      deviceReadScreenshot?: ScreenshotEncodingOptions;
    },
  ): Promise<ObserveResult> {
    const { options, deadline, deviceReadScreenshot } = request;
    const remaining = Math.max(0, deadline - this.d.timer().now());
    const controller = new AbortController();
    const callerSignal = options?.signal;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    let timedOut = remaining === 0;
    try {
      callerSignal?.throwIfAborted();
      if (timedOut) {
        throw new DisplaySelectionError("Observe deadline reached; retry this panel separately.");
      }
      return await raceWithDeadline(
        async () => {
          const result = await this.d.executeSingleDisplay({
            ...options,
            display,
            signal,
            timeoutMs: remaining,
            skipCache: true,
            preserveDisplayState: true,
          });
          if (deviceReadScreenshot !== undefined) {
            await this.d.captureDeviceReadScreenshot(result, signal, deviceReadScreenshot, {
              display,
            });
          }
          return result;
        },
        {
          timer: this.d.timer(),
          timeoutMs: remaining,
          signal: callerSignal,
          label: `Observe display ${display}`,
          onTimeout: () => {
            timedOut = true;
            controller.abort();
          },
        },
      );
    } catch (error) {
      callerSignal?.throwIfAborted();
      logger.warn(`[ObserveScreen] Display ${display} unavailable: ${describeError(error)}`, error);
      if (display === "active" && !timedOut) {
        return this.d.createCriticalFallback(error);
      }
      const result = this.d.createBaseResult();
      const panel = resolveTargetDisplay(this.d.device().displays, display, {
        focusedPanelKey: displayTransitions.observedPanel(this.d.device().deviceId)?.key,
      });
      result.display = {
        ...result.display,
        key: panel.key,
        role: panel.role,
        generation: displayTransitions.identityRevision(this.d.device().deviceId),
      };
      result.screenSize = { ...panel.sizePx, units: "physical-pixels" };
      result.freshness = computeFreshness({
        now: this.d.timer().now(),
        unavailable: true,
        unavailableReason: timedOut ? "request_timed_out" : "unknown",
        unavailableDetail: describeError(error),
      });
      return result;
    }
  }
}
