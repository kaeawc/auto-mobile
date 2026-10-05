import { z } from "zod";
import { ActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { actionSchema, overlaySpecSchema, type OverlaySpec } from "../../overlay/overlaySpec";
import { validateOverlaySpec } from "../../overlay/overlayValidation";
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

const overlayEventSchema = z.object({
  type: z.literal("overlay_event"),
  timestamp: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: z.string().min(1),
  sequence: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: z.enum(["emit", "page_changed", "dismissed"]),
  name: z.string().nullable(),
  payload: actionSchema.options[0].shape.payload.unwrap(),
  state: overlaySpecSchema.shape.state.unwrap(),
  pages: z.record(z.string().min(1), z.number().int().nonnegative().max(2147483647)).default({}),
});

export class CtrlProxyOverlays {
  private readonly listeners = new Set<(event: OverlayEvent) => void>();

  constructor(private readonly context: DelegateContext) {}

  async requestShowOverlay(
    spec: OverlaySpec,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    this.validateSpec(spec);
    return this.request(ctrlProxyRequests.showOverlay({ requestId: "", spec }), timeoutMs, perf);
  }

  async requestUpdateOverlay(
    update: OverlayUpdate,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    if (update.spec !== undefined) {
      this.validateSpec(update.spec);
      if (update.id !== update.spec.id) {
        throw new ActionableError("Invalid overlay at spec.id: must equal update_overlay id");
      }
    } else {
      const state = overlaySpecSchema.shape.state.safeParse(update.state);
      if (!state.success) {
        throw new ActionableError(`Invalid overlay at state: ${state.error.message}`);
      }
    }
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

  private validateSpec(spec: OverlaySpec): void {
    // Host enforces strict properties and limits; device decoding remains lenient.
    // Device re-validation belongs to #9297/#9299. Reuse the schema-backed path formatter.
    const validated = validateOverlaySpec(spec);
    if (!validated.success) {
      throw new ActionableError(
        `Invalid overlay at ${validated.error.path}: ${validated.error.message}`,
      );
    }
  }

  private async request(
    message: ShowOverlayMessage | UpdateOverlayMessage | DismissOverlayMessage,
    timeoutMs: number,
    perf?: PerformanceTracker,
  ): Promise<OverlayResult> {
    const connected = perf
      ? await perf.track("ensureConnected", () => this.context.ensureConnected(perf))
      : await this.context.ensureConnected();
    if (!connected) {
      return { success: false, error: "Not connected", totalTimeMs: 0 };
    }
    const type = message.type;
    if (this.context.isCommandSupported?.(type) === false) {
      throw new ActionableError(
        `${type}: this CtrlProxy build does not support overlays; update the connected CtrlProxy.`,
      );
    }
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
      requireExistingConnection: true,
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
    if (typeof frame === "object" && frame !== null && Object.hasOwn(frame, "requestId")) {
      logger.warn("[CTRL_PROXY] Dropping overlay_event carrying requestId");
      return;
    }
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
