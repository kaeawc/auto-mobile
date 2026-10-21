/**
 * CtrlProxyHighlights - Delegate for visual highlight overlay operations.
 *
 * This delegate handles adding and managing visual highlight overlays on the device.
 */

import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import type { HighlightOperationResult, HighlightShape } from "../../../models";
import type { DelegateContext, NormalizedHighlightBounds } from "./types";
import { sendCommand } from "../DeviceServiceUtils";

/**
 * Delegate class for handling visual highlight overlay operations.
 */
export class CtrlProxyHighlights {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /**
   * Add a visual highlight overlay entry.
   */
  async requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<HighlightOperationResult> {
    return this.requestHighlightOperation("add_highlight", { id, shape }, timeoutMs, perf);
  }

  /**
   * Internal method to perform highlight operations.
   */
  private async requestHighlightOperation(
    type: "add_highlight",
    payload: { id: string; shape: HighlightShape },
    timeoutMs: number,
    perf: PerformanceTracker,
  ): Promise<HighlightOperationResult> {
    const startTime = this.context.timer.now();

    try {
      // Omit falsy id/shape from the wire rather than serializing null, as the builder does.
      const params: Record<string, unknown> = {};
      if (payload.id) {
        params.id = payload.id;
      }
      if (payload.shape) {
        params.shape = this.normalizeHighlightShape(payload.shape);
      }
      const result = await sendCommand<HighlightOperationResult>(
        // Highlights never went through the generic command gate or wire deadlines.
        { ...this.context, isCommandSupported: undefined, wireDeadlineParams: undefined },
        {
          idPrefix: "highlight",
          responseType: "highlight",
          messageType: type,
          params,
          timeoutMs,
          perf,
          cancelScreenshotBackoff: false,
          notConnectedError: () => {
            logger.warn(
              "[CTRL_PROXY] Failed to establish WebSocket connection for highlight operation",
            );
            return { success: false, error: "Failed to connect to accessibility service" };
          },
          timeoutError: (timeout) => ({
            success: false,
            error: `Highlight request timeout after ${timeout}ms`,
          }),
          unsupportedCommandError: (_messageType, error) => ({ success: false, error }),
        },
      );
      const duration = this.context.timer.now() - startTime;

      if (result.success) {
        logger.info(`[CTRL_PROXY] Highlight ${type} completed in ${duration}ms`);
      } else {
        logger.warn(`[CTRL_PROXY] Highlight ${type} failed after ${duration}ms: ${result.error}`);
      }

      return result;
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Highlight ${type} request failed after ${duration}ms: ${error}`);
      return {
        success: false,
        error: `${error}`,
      };
    }
  }

  /**
   * Normalize highlight shape bounds to integers.
   */
  private normalizeHighlightShape(shape: HighlightShape): HighlightShape {
    const normalizeBounds = (bounds: HighlightShape["bounds"]): NormalizedHighlightBounds => {
      return {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        sourceWidth:
          bounds.sourceWidth === null || bounds.sourceWidth === undefined
            ? bounds.sourceWidth
            : Math.round(bounds.sourceWidth),
        sourceHeight:
          bounds.sourceHeight === null || bounds.sourceHeight === undefined
            ? bounds.sourceHeight
            : Math.round(bounds.sourceHeight),
      };
    };

    return {
      ...shape,
      bounds: normalizeBounds(shape.bounds),
    };
  }
}
