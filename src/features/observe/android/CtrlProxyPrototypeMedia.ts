import { boundedPrototypeError } from "../../prototype/prototypeErrors";
import { DEFAULT_PROTOTYPE_ASSET_TIMEOUT_MS } from "../../prototype/prototypeAssets";
import type {
  PrototypeMediaTransportMessage,
  PrototypeMediaTransportResult,
} from "../../prototype/prototypeMediaUpload";
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import { sendCommand } from "../DeviceServiceUtils";
import type { PrototypeResult } from "./ctrlProxyProtocol";
import type { PrototypeAssetRequestOptions } from "./CtrlProxyPrototypes";
import type { DelegateContext } from "./types";

/** A media upload message is never retried, so it has no dispatch hook. */
export type PrototypeMediaRequestOptions = Pick<
  PrototypeAssetRequestOptions,
  "abortSignal" | "timeoutMs"
>;

/** Sends the chunked media upload messages (#14254) to CtrlProxy, one `prototype_result` each. */
export class CtrlProxyPrototypeMedia {
  constructor(private readonly context: DelegateContext) {}

  /**
   * Sends one media upload message. A device refusal, or a message that was never sent, resolves
   * `success: false` (with the device's `code` for a refusal): the device holds nothing for it. A
   * message written but never answered throws, because the device may have acted on it; the
   * uploader then sends an abort.
   */
  async requestPrototypeMediaMessage(
    message: PrototypeMediaTransportMessage,
    options: PrototypeMediaRequestOptions = {},
  ): Promise<PrototypeMediaTransportResult> {
    if (!(await this.connect())) {
      return { success: false, error: "Not connected" };
    }
    if (this.context.isCommandSupported?.(message.type) === false) {
      throw new ActionableError(
        `${message.type}: this CtrlProxy build does not support prototype media assets; update the connected CtrlProxy.`,
      );
    }
    const delivery: { dispatched: boolean; unanswered?: string } = { dispatched: false };
    try {
      const result = await this.send(message, options, delivery);
      if (delivery.unanswered === undefined) {
        return mediaResult(result);
      }
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      logger.warn("[CTRL_PROXY] Prototype media transport failed", error);
      if (!delivery.dispatched) {
        return { success: false, error: errorMessage(error) };
      }
      delivery.unanswered = errorMessage(error);
    }
    throw new ActionableError(
      `${message.type} for media asset '${message.id}' was sent but not answered (${delivery.unanswered}).`,
    );
  }

  private send(
    message: PrototypeMediaTransportMessage,
    options: PrototypeMediaRequestOptions,
    delivery: { dispatched: boolean; unanswered?: string },
  ): Promise<PrototypeResult> {
    const { type, ...params } = message;
    return sendCommand<PrototypeResult>(this.context, {
      idPrefix: "prototypeMedia",
      responseType: "prototype_result",
      messageType: type,
      params,
      timeoutMs: options.timeoutMs ?? DEFAULT_PROTOTYPE_ASSET_TIMEOUT_MS,
      abortSignal: options.abortSignal,
      requireExistingConnection: true,
      onDispatch: () => {
        delivery.dispatched = true;
      },
      timeoutError: (timeout) => {
        delivery.unanswered = `timed out after ${timeout}ms`;
        return { success: false, totalTimeMs: timeout, error: delivery.unanswered };
      },
    });
  }

  private async connect(): Promise<boolean> {
    try {
      return await this.context.ensureConnected();
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      logger.warn("[CTRL_PROXY] Prototype media connection failed", error);
      return false;
    }
  }
}

function mediaResult(result: PrototypeResult): PrototypeMediaTransportResult {
  return {
    success: result.success && !result.error,
    ...(result.mediaCode ? { code: result.mediaCode } : {}),
    ...(result.error ? { error: boundedPrototypeError(result.error) } : {}),
  };
}
