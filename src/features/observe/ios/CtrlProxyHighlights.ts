/**
 * CtrlProxy iOS Highlights - Delegate for visual highlight overlay operations.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { sendCommand } from "../DeviceServiceUtils";
import type { HighlightBounds, HighlightOperationResult, HighlightShape } from "../../../models";
import type { DelegateContext } from "./types";

export class CtrlProxyHighlights {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  async requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<HighlightOperationResult> {
    return sendCommand<HighlightOperationResult>(this.context, {
      idPrefix: "highlight",
      responseType: "highlight",
      messageType: "add_highlight",
      params: {
        id,
        shape: this.normalizeHighlightShape(shape),
      },
      timeoutMs,
      perf,
      cancelScreenshotBackoff: false,
      notConnectedError: () => ({
        success: false,
        error: "Not connected to CtrlProxy",
      }),
      timeoutError: (timeout) => ({
        success: false,
        error: `Highlight request timeout after ${timeout}ms`,
      }),
      unsupportedCommandError: (_messageType, error) => ({
        success: false,
        error,
      }),
    });
  }

  private normalizeHighlightShape(shape: HighlightShape): HighlightShape {
    const normalizeBounds = (bounds: HighlightBounds): HighlightBounds => {
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

    if (shape.type === "path") {
      return {
        ...shape,
        bounds: shape.bounds ? normalizeBounds(shape.bounds) : shape.bounds,
      };
    }

    return {
      ...shape,
      bounds: normalizeBounds(shape.bounds),
    };
  }
}
