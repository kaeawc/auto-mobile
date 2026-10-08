import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import { z } from "zod";
import { ActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { actionSchema, overlaySpecSchema, type OverlaySpec } from "../../overlay/overlaySpec";
import {
  DEFAULT_OVERLAY_ASSET_TIMEOUT_MS,
  overlayAssetIdProblem,
  overlayAssetUploadProblem,
  type OverlayAssetUpload,
} from "../../overlay/overlayAssets";
import { validateOverlaySpec } from "../../overlay/overlayValidation";
import { errorMessage } from "../../../utils/describeUnknownError";
import { sendCommand } from "../DeviceServiceUtils";
import type { DelegateContext } from "./types";
import {
  ctrlProxyRequests,
  OVERLAY_DISPLAY_CAPABILITY,
  type ShowOverlayMessage,
  type UpdateOverlayMessage,
  type DismissOverlayMessage,
  type OverlayAssetResult,
  type OverlayDismiss,
  type OverlayEvent,
  type OverlayResult,
  type OverlayUpdate,
  type PutOverlayAssetMessage,
  type RemoveOverlayAssetMessage,
} from "./ctrlProxyProtocol";

/** Shared by the client transport guard and the tool-level refusal. */
export function overlayDisplayUnsupportedMessage(displayId: number): string {
  return `show_overlay: the connected CtrlProxy does not advertise ${OVERLAY_DISPLAY_CAPABILITY}, so it cannot show an overlay on display ${displayId} and would place it on the default display; update the connected CtrlProxy or omit display.`;
}

/** Transport controls shared by asset upload and removal. */
export interface OverlayAssetRequestOptions {
  timeoutMs?: number;
  perf?: PerformanceTracker;
  /** Aborting before dispatch sends nothing; aborting after leaves the outcome indeterminate. */
  abortSignal?: AbortSignal;
  /** Called synchronously once the frame is written to the socket. */
  onDispatch?: () => void;
}

/** Decodes one `overlay_event` push; shared by CtrlProxy and the iOS overlay agent transport. */
export const overlayEventSchema = z.object({
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

  /**
   * [displayId] is the Android logical display; undefined and 0 both mean the default display and
   * keep the wire byte-identical to a request from before display targeting existed.
   */
  async requestShowOverlay(
    spec: OverlaySpec,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
    displayId?: number,
  ): Promise<OverlayResult> {
    this.validateSpec(spec);
    const target = displayId === undefined || displayId === 0 ? undefined : displayId;
    return this.request(
      ctrlProxyRequests.showOverlay({ requestId: "", spec, displayId: target }),
      timeoutMs,
      perf,
    );
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

  /**
   * Uploads one image asset, replacing any asset with the same id. Invalid input and an old device
   * throw before anything is sent. A device refusal (store full, bad bytes) is a plain failure with
   * `acknowledged: true`. A frame that was written but never answered is indeterminate: the asset
   * may or may not be stored, and re-sending is safe because the id replaces.
   */
  async requestPutOverlayAsset(
    asset: OverlayAssetUpload,
    options: OverlayAssetRequestOptions = {},
  ): Promise<OverlayAssetResult> {
    const problem = overlayAssetUploadProblem(asset);
    if (problem !== null) {
      throw new ActionableError(`Invalid overlay asset: ${problem}`);
    }
    const { bytes } = asset;
    const dataBase64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "base64",
    );
    return this.sendAssetRequest(
      ctrlProxyRequests.putOverlayAsset({
        requestId: "",
        id: asset.id,
        mimeType: asset.mimeType,
        dataBase64,
      }),
      `Upload of overlay asset '${asset.id}'`,
      options,
    );
  }

  /** Removes one asset. Idempotent on the device: an unknown id still succeeds. */
  async requestRemoveOverlayAsset(
    id: string,
    options: OverlayAssetRequestOptions = {},
  ): Promise<OverlayAssetResult> {
    const problem = overlayAssetIdProblem(id);
    if (problem !== null) {
      throw new ActionableError(`Invalid overlay asset: ${problem}`);
    }
    return this.sendAssetRequest(
      ctrlProxyRequests.removeOverlayAsset({ requestId: "", id }),
      `Removal of overlay asset '${id}'`,
      options,
    );
  }

  private async sendAssetRequest(
    message: PutOverlayAssetMessage | RemoveOverlayAssetMessage,
    label: string,
    options: OverlayAssetRequestOptions,
  ): Promise<OverlayAssetResult> {
    const startMs = this.context.timer.now();
    let dispatched = false;
    let unconfirmed = false;
    const settle = (result: OverlayResult): OverlayAssetResult => ({
      ...result,
      dispatched,
      acknowledged: dispatched && !unconfirmed,
    });
    const describe = (reason: string): string =>
      dispatched
        ? `${label} outcome is indeterminate: the request was dispatched but no device reply was confirmed (${reason}). The asset may or may not be stored; sending the same request again is safe.`
        : reason;
    const failure = (reason: string): OverlayAssetResult => {
      unconfirmed = true;
      return settle({
        success: false,
        totalTimeMs: this.context.timer.now() - startMs,
        error: describe(reason),
      });
    };

    if (!(await this.connectForAsset(options))) {
      return settle({ success: false, error: "Not connected", totalTimeMs: 0 });
    }
    this.requireAssetSupport(message.type);
    const params: Record<string, unknown> = { ...message };
    delete params.type;
    delete params.requestId;
    try {
      const result = await sendCommand<OverlayResult>(this.context, {
        idPrefix: "overlayAsset",
        responseType: "overlay_result",
        messageType: message.type,
        params,
        timeoutMs: options.timeoutMs ?? DEFAULT_OVERLAY_ASSET_TIMEOUT_MS,
        perf: options.perf,
        abortSignal: options.abortSignal,
        requireExistingConnection: true,
        onDispatch: () => {
          dispatched = true;
          options.onDispatch?.();
        },
        timeoutError: (timeout) => {
          unconfirmed = true;
          return {
            success: false,
            totalTimeMs: timeout,
            error: describe(`timed out after ${timeout}ms`),
          };
        },
      });
      return settle(result);
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      logger.warn("[CTRL_PROXY] Overlay asset transport failed", error);
      return failure(errorMessage(error));
    }
  }

  private async connectForAsset(options: OverlayAssetRequestOptions): Promise<boolean> {
    try {
      return options.perf
        ? await options.perf.track("ensureConnected", () =>
            this.context.ensureConnected(options.perf),
          )
        : await this.context.ensureConnected();
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      logger.warn("[CTRL_PROXY] Overlay asset connection failed", error);
      return false;
    }
  }

  private requireAssetSupport(
    type: PutOverlayAssetMessage["type"] | RemoveOverlayAssetMessage["type"],
  ): void {
    if (this.context.isCommandSupported?.(type) === false) {
      throw new ActionableError(
        `${type}: this CtrlProxy build does not support overlay assets; update the connected CtrlProxy.`,
      );
    }
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
    if (
      message.type === "show_overlay" &&
      message.displayId !== undefined &&
      this.context.isCommandSupported?.(OVERLAY_DISPLAY_CAPABILITY) !== true
    ) {
      // Never send displayId to a device that would ignore it and show on the default display.
      throw new ActionableError(overlayDisplayUnsupportedMessage(message.displayId));
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
