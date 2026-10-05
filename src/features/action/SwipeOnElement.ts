import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { BootedDevice, GestureOptions } from "../../models";
import { Element } from "../../models";
import { ExecuteGesture } from "./ExecuteGesture";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { SwipeResult } from "../../models";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { IOSCtrlProxyClient } from "../observe/ios";
import { throwIfAborted } from "../../utils/toolUtils";

/**
 * Executes swipe gestures on specific UI elements
 */
export class SwipeOnElement extends BaseVisualChange {
  private executeGesture: Pick<ExecuteGesture, "swipe">;
  private geometry: ElementGeometry;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    geometry: ElementGeometry = new DefaultElementGeometry(),
    executeGesture?: Pick<ExecuteGesture, "swipe">,
  ) {
    super(device, adb);
    this.executeGesture = executeGesture ?? new ExecuteGesture(device, adb);
    this.geometry = geometry;
  }

  /**
   * Swipe on a specific element in a given direction
   * @param element - The element to swipe on
   * @param direction - Direction to swipe ('up', 'down', 'left', 'right')
   * @param options - Additional gesture options
   * @param progress - Optional progress callback
   * @returns Result of the swipe operation
   */
  async execute(
    element: Element,
    direction: "up" | "down" | "left" | "right",
    options: GestureOptions = {},
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<SwipeResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("swipeOnElement");

    logger.info(
      `[SwipeOnElement] Starting swipe: direction=${direction}, platform=${this.device.platform}`,
    );
    logger.info(`[SwipeOnElement] Element bounds: ${JSON.stringify(element.bounds)}`);
    logger.info(`[SwipeOnElement] Options: ${JSON.stringify(options)}`);
    let iosDispatchTimestamp: number | undefined;

    return this.observedInteraction(
      async () => {
        throwIfAborted(signal);
        logger.info(`[SwipeOnElement] In observedInteraction callback`);

        const { startX, startY, endX, endY } = this.geometry.getSwipeWithinBounds(
          direction,
          element.bounds,
        );

        logger.info(
          `[SwipeOnElement] Raw swipe coordinates: start=(${startX}, ${startY}), end=(${endX}, ${endY})`,
        );

        const flooredStartX = Math.floor(startX);
        const flooredStartY = Math.floor(startY);
        const flooredEndX = Math.floor(endX);
        const flooredEndY = Math.floor(endY);

        logger.info(
          `[SwipeOnElement] Floored swipe coordinates: start=(${flooredStartX}, ${flooredStartY}), end=(${flooredEndX}, ${flooredEndY})`,
        );

        try {
          const result = await perf.track("executeSwipe", () =>
            this.executeGesture.swipe(
              flooredStartX,
              flooredStartY,
              flooredEndX,
              flooredEndY,
              options,
              perf,
              signal,
            ),
          );
          if (this.device.platform === "ios" && result.success) {
            iosDispatchTimestamp = this.timer.now();
            IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.invalidateCache();
          }
          logger.info(`[SwipeOnElement] Swipe completed successfully: ${JSON.stringify(result)}`);
          return result;
        } catch (error) {
          perf.end();
          logger.error(`[SwipeOnElement] Swipe execution failed: ${error}`);
          throw error;
        }
      },
      {
        usesObservationForResolution: false,
        changeExpected: false,
        timeoutMs: 500,
        progress,
        perf,
        signal,
        observationTimestampProvider: () => iosDispatchTimestamp,
      },
    );
  }
}
