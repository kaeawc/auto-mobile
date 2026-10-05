import { z } from "zod";
import { ActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { actionSchema, overlaySpecSchema, type OverlaySpec } from "../../overlay/overlaySpec";
import { sendCommand } from "../DeviceServiceUtils";
import type { DelegateContext } from "./types";
import {
  ctrlProxyRequests,
  type ShowOverlayMessage,
  type UpdateOverlayMessage,
  type DismissOverlayMessage,
  type OverlayDismiss,
  type OverlayEvent,
  type OverlayResult,
  type OverlayUpdate,
} from "./ctrlProxyProtocol";

/** First release containing the overlay wire commands (0.0.82 predates them). */
export const OVERLAY_MIN_CTRL_PROXY_VERSION = "0.0.83";

const overlayEventSchema = z
  .object({
    type: z.literal("overlay_event"),
    timestamp: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    id: z.string().min(1),
    sequence: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(["emit", "page_changed", "dismissed"]),
    name: z.string().nullable(),
    payload: actionSchema.options[0].shape.payload.unwrap(),
    state: overlaySpecSchema.shape.state.unwrap(),
    pages: z.record(z.string().min(1), z.number().int().nonnegative().max(2147483647)).default({}),
  })
  .strict();

export class CtrlProxyOverlays {
  private readonly listeners = new Set<(event: OverlayEvent) => void>();

  constructor(private readonly context: DelegateContext) {}

  requestShowOverlay(
    spec: OverlaySpec,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    return this.request(ctrlProxyRequests.showOverlay({ requestId: "", spec }), timeoutMs, perf);
  }

  requestUpdateOverlay(
    update: OverlayUpdate,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    return this.request(
      ctrlProxyRequests.updateOverlay({ requestId: "", ...update }),
      timeoutMs,
      perf,
    );
  }

  requestDismissOverlay(
    target: OverlayDismiss,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    return this.request(
      ctrlProxyRequests.dismissOverlay({ requestId: "", ...target }),
      timeoutMs,
      perf,
    );
  }

  private request(
    message: ShowOverlayMessage | UpdateOverlayMessage | DismissOverlayMessage,
    timeoutMs: number,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    const type = message.type;
    const params: Record<string, unknown> = { ...message };
    delete params.type;
    delete params.requestId;
    return sendCommand<OverlayResult>(this.context, {
      idPrefix: "overlay",
      responseType: "overlay_result",
      messageType: type,
      params,
      timeoutMs,
      perf,
      unsupportedCommandError: (messageType) => {
        throw new ActionableError(
          messageType +
            " requires CtrlProxy " +
            OVERLAY_MIN_CTRL_PROXY_VERSION +
            " or newer; update the connected CtrlProxy.",
        );
      },
    });
  }

  onOverlayEvent(listener: (event: OverlayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Decode at the push boundary: malformed frames never escape into listeners. */
  handleOverlayEvent(frame: unknown): void {
    const decoded = overlayEventSchema.safeParse(frame);
    if (!decoded.success) {
      logger.warn("[CTRL_PROXY] Dropping malformed overlay_event", decoded.error);
      return;
    }
    if (this.listeners.size === 0) {
      logger.debug("[CTRL_PROXY] overlay_event has no subscribers");
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(decoded.data);
      } catch (error) {
        // One failed consumer must not interrupt delivery to the remaining subscribers.
        logger.warn("[CTRL_PROXY] Overlay event listener failed", error);
      }
    }
  }
}
