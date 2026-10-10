import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import { z } from "zod";
import { ActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import {
  actionSchema,
  prototypeSpecSchema,
  type PrototypeSpec,
} from "../../prototype/prototypeSpec";
import {
  DEFAULT_PROTOTYPE_ASSET_TIMEOUT_MS,
  prototypeAssetIdProblem,
  prototypeAssetUploadProblem,
  type PrototypeAssetUpload,
} from "../../prototype/prototypeAssets";
import { validatePrototypeSpec } from "../../prototype/prototypeValidation";
import { errorMessage } from "../../../utils/describeUnknownError";
import { sendCommand } from "../DeviceServiceUtils";
import type { DelegateContext } from "./types";
import {
  ctrlProxyRequests,
  PROTOTYPE_DISPLAY_CAPABILITY,
  PROTOTYPE_EVENT_KINDS,
  PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY,
  UNKNOWN_PROTOTYPE_EVENT_KIND,
  type PrototypeAppearanceOverride,
  type InspectPrototypesMessage,
  type ShowPrototypeMessage,
  type DismissPrototypeMessage,
  type PrototypeAssetResult,
  type PrototypeDismiss,
  type PrototypeEvent,
  type PrototypeResult,
  type PutPrototypeAssetMessage,
  type RemovePrototypeAssetMessage,
} from "./ctrlProxyProtocol";

/** Shared by the client transport guard and the tool-level refusal. */
export function prototypeDisplayUnsupportedMessage(displayId: number): string {
  return `show_prototype: the connected CtrlProxy does not advertise ${PROTOTYPE_DISPLAY_CAPABILITY}, so it cannot show a prototype on display ${displayId} and would place it on the default display; update the connected CtrlProxy or omit display.`;
}

/** Shared by the client transport guard and the tool-level refusal. */
export function prototypeInspectUnsupportedMessage(): string {
  return `inspect_prototypes: the connected CtrlProxy does not advertise ${PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY}, so it cannot report the prototypes it is showing or replay events buffered while no host was connected; update the connected CtrlProxy.`;
}

/** Transport controls shared by asset upload and removal. */
export interface PrototypeAssetRequestOptions {
  timeoutMs?: number;
  perf?: PerformanceTracker;
  /** Aborting before dispatch sends nothing; aborting after leaves the outcome indeterminate. */
  abortSignal?: AbortSignal;
  /** Called synchronously once the frame is written to the socket. */
  onDispatch?: () => void;
}

/** Matches the device's offline ring (PROTOTYPE_OFFLINE_EVENT_CAPACITY in CtrlProxy). */
const STAGED_PROTOTYPE_EVENT_CAPACITY = 200;

/** What every `prototype_event` carries whatever its kind: enough to advance the sequence ledger. */
const prototypeEventEnvelopeSchema = z.object({
  type: z.literal("prototype_event"),
  timestamp: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: z.string().min(1),
  sequence: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: z.string().min(1),
});

/** One `prototype_event` push of a kind this host knows. */
export const prototypeEventSchema = prototypeEventEnvelopeSchema.extend({
  kind: z.enum(PROTOTYPE_EVENT_KINDS),
  name: z.string().nullable(),
  payload: actionSchema.options[0].shape.payload.unwrap(),
  state: prototypeSpecSchema.shape.state.unwrap(),
  pages: z.record(z.string().min(1), z.number().int().nonnegative().max(2147483647)).default({}),
});

/**
 * Decodes one `prototype_event` push; shared by CtrlProxy and the iOS prototype agent transport.
 * A malformed frame is logged and dropped (undefined). A well-formed frame whose `kind` this host
 * does not know (a newer device) is logged at warn and returned as an
 * {@link UNKNOWN_PROTOTYPE_EVENT_KIND} event holding only id, sequence and timestamp, so the
 * consumer advances its sequence ledger and skips it instead of losing the frame.
 */
export function decodePrototypeEvent(
  frame: unknown,
  logPrefix: string,
): PrototypeEvent | undefined {
  const decoded = prototypeEventSchema.safeParse(frame);
  if (decoded.success) {
    return decoded.data;
  }
  const envelope = prototypeEventEnvelopeSchema.safeParse(frame);
  if (!envelope.success || isKnownPrototypeEventKind(envelope.data.kind)) {
    logger.warn(`${logPrefix} Dropping malformed prototype_event`, decoded.error);
    return undefined;
  }
  const { id, sequence, timestamp, kind } = envelope.data;
  logger.warn(
    `${logPrefix} Skipping prototype_event of unknown kind "${kind}" (prototype ${id}, sequence ${sequence}); update AutoMobile to receive it`,
  );
  return {
    type: "prototype_event",
    timestamp,
    id,
    sequence,
    kind: UNKNOWN_PROTOTYPE_EVENT_KIND,
    name: null,
    payload: null,
    state: {},
    pages: {},
  };
}

function isKnownPrototypeEventKind(kind: string): boolean {
  return (PROTOTYPE_EVENT_KINDS as readonly string[]).includes(kind);
}

export class CtrlProxyPrototypes {
  private readonly listeners = new Set<(event: PrototypeEvent) => void>();
  /** Pushes that arrived with no subscriber; bounded like the device's offline ring. */
  private readonly staged: PrototypeEvent[] = [];

  constructor(private readonly context: DelegateContext) {}

  /**
   * [displayId] is the Android logical display; undefined and 0 both mean the default display and
   * keep the wire byte-identical to a request from before display targeting existed. [reset] true
   * starts a same-id show fresh instead of replacing it in place; false/undefined send nothing.
   * [appearance] pins the system setting for this show; the caller passes it only for a device
   * advertising `prototype_appearance_v1`, and undefined (follow the device) sends nothing.
   */
  async requestShowPrototype(
    spec: PrototypeSpec,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
    displayId?: number,
    reset?: boolean,
    appearance?: PrototypeAppearanceOverride,
  ): Promise<PrototypeResult> {
    this.validateSpec(spec);
    const target = displayId === undefined || displayId === 0 ? undefined : displayId;
    return this.request(
      ctrlProxyRequests.showPrototype({
        requestId: "",
        spec,
        displayId: target,
        reset,
        appearance,
      }),
      timeoutMs,
      perf,
    );
  }

  requestDismissPrototype(
    target: PrototypeDismiss,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    return this.request(
      ctrlProxyRequests.dismissPrototype({ requestId: "", ...target }),
      timeoutMs,
      perf,
    );
  }

  /**
   * Asks the device which prototypes it is showing. The device first delivers any events it buffered
   * while no host was connected (through [onPrototypeEvent]), then answers with `prototypes`. Throws
   * before sending when the device does not advertise `prototype_persistence_replay_v1`.
   */
  requestInspectPrototypes(timeoutMs = 5000, perf?: PerformanceTracker): Promise<PrototypeResult> {
    return this.request(ctrlProxyRequests.inspectPrototypes({ requestId: "" }), timeoutMs, perf);
  }

  /**
   * Uploads one image asset, replacing any asset with the same id. Invalid input and an old device
   * throw before anything is sent. A device refusal (store full, bad bytes) is a plain failure with
   * `acknowledged: true`. A frame that was written but never answered is indeterminate: the asset
   * may or may not be stored, and re-sending is safe because the id replaces.
   */
  async requestPutPrototypeAsset(
    asset: PrototypeAssetUpload,
    options: PrototypeAssetRequestOptions = {},
  ): Promise<PrototypeAssetResult> {
    const problem = prototypeAssetUploadProblem(asset);
    if (problem !== null) {
      throw new ActionableError(`Invalid prototype asset: ${problem}`);
    }
    const { bytes } = asset;
    const dataBase64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "base64",
    );
    return this.sendAssetRequest(
      ctrlProxyRequests.putPrototypeAsset({
        requestId: "",
        id: asset.id,
        mimeType: asset.mimeType,
        dataBase64,
      }),
      `Upload of prototype asset '${asset.id}'`,
      options,
    );
  }

  /** Removes one asset. Idempotent on the device: an unknown id still succeeds. */
  async requestRemovePrototypeAsset(
    id: string,
    options: PrototypeAssetRequestOptions = {},
  ): Promise<PrototypeAssetResult> {
    const problem = prototypeAssetIdProblem(id);
    if (problem !== null) {
      throw new ActionableError(`Invalid prototype asset: ${problem}`);
    }
    return this.sendAssetRequest(
      ctrlProxyRequests.removePrototypeAsset({ requestId: "", id }),
      `Removal of prototype asset '${id}'`,
      options,
    );
  }

  private async sendAssetRequest(
    message: PutPrototypeAssetMessage | RemovePrototypeAssetMessage,
    label: string,
    options: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult> {
    const startMs = this.context.timer.now();
    let dispatched = false;
    let unconfirmed = false;
    const settle = (result: PrototypeResult): PrototypeAssetResult => ({
      ...result,
      dispatched,
      acknowledged: dispatched && !unconfirmed,
    });
    const describe = (reason: string): string =>
      dispatched
        ? `${label} outcome is indeterminate: the request was dispatched but no device reply was confirmed (${reason}). The asset may or may not be stored; sending the same request again is safe.`
        : reason;
    const failure = (reason: string): PrototypeAssetResult => {
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
      const result = await sendCommand<PrototypeResult>(this.context, {
        idPrefix: "prototypeAsset",
        responseType: "prototype_result",
        messageType: message.type,
        params,
        timeoutMs: options.timeoutMs ?? DEFAULT_PROTOTYPE_ASSET_TIMEOUT_MS,
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
      logger.warn("[CTRL_PROXY] Prototype asset transport failed", error);
      return failure(errorMessage(error));
    }
  }

  private async connectForAsset(options: PrototypeAssetRequestOptions): Promise<boolean> {
    try {
      return options.perf
        ? await options.perf.track("ensureConnected", () =>
            this.context.ensureConnected(options.perf),
          )
        : await this.context.ensureConnected();
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      logger.warn("[CTRL_PROXY] Prototype asset connection failed", error);
      return false;
    }
  }

  private requireAssetSupport(
    type: PutPrototypeAssetMessage["type"] | RemovePrototypeAssetMessage["type"],
  ): void {
    if (this.context.isCommandSupported?.(type) === false) {
      throw new ActionableError(
        `${type}: this CtrlProxy build does not support prototype assets; update the connected CtrlProxy.`,
      );
    }
  }

  private validateSpec(spec: PrototypeSpec): void {
    // Host enforces strict properties and limits; device decoding remains lenient.
    // Device re-validation belongs to #9297/#9299. Reuse the schema-backed path formatter.
    const validated = validatePrototypeSpec(spec);
    if (!validated.success) {
      throw new ActionableError(
        `Invalid prototype at ${validated.error.path}: ${validated.error.message}`,
      );
    }
  }

  private async request(
    message: ShowPrototypeMessage | DismissPrototypeMessage | InspectPrototypesMessage,
    timeoutMs: number,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    const connected = perf
      ? await perf.track("ensureConnected", () => this.context.ensureConnected(perf))
      : await this.context.ensureConnected();
    if (!connected) {
      return { success: false, error: "Not connected", totalTimeMs: 0 };
    }
    const type = message.type;
    if (this.context.isCommandSupported?.(type) === false) {
      throw new ActionableError(
        `${type}: this CtrlProxy build does not support prototypes; update the connected CtrlProxy.`,
      );
    }
    if (
      message.type === "inspect_prototypes" &&
      this.context.isCommandSupported?.(PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY) !== true
    ) {
      throw new ActionableError(prototypeInspectUnsupportedMessage());
    }
    if (
      message.type === "show_prototype" &&
      message.displayId !== undefined &&
      this.context.isCommandSupported?.(PROTOTYPE_DISPLAY_CAPABILITY) !== true
    ) {
      // Never send displayId to a device that would ignore it and show on the default display.
      throw new ActionableError(prototypeDisplayUnsupportedMessage(message.displayId));
    }
    const params: Record<string, unknown> = { ...message };
    delete params.type;
    delete params.requestId;
    return sendCommand<PrototypeResult>(this.context, {
      idPrefix: "prototype",
      responseType: "prototype_result",
      messageType: type,
      params,
      timeoutMs,
      perf,
      requireExistingConnection: true,
    });
  }

  onPrototypeEvent(listener: (event: PrototypeEvent) => void): () => void {
    this.listeners.add(listener);
    // The device drains its offline ring on any connect, not only for inspect. Events that arrived
    // with nobody listening go to the first subscriber, in wire order, instead of being lost.
    for (const event of this.staged.splice(0)) {
      this.deliver(listener, event);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Decode at the push boundary: malformed frames never escape into listeners. */
  handlePrototypeEvent(frame: unknown): void {
    if (typeof frame === "object" && frame !== null && Object.hasOwn(frame, "requestId")) {
      logger.warn("[CTRL_PROXY] Dropping prototype_event carrying requestId");
      return;
    }
    const decoded = decodePrototypeEvent(frame, "[CTRL_PROXY]");
    if (decoded === undefined) {
      return;
    }
    if (this.listeners.size === 0) {
      // Not a drop: the next subscriber (an inspect or a shown prototype) receives it.
      this.staged.push(decoded);
      if (this.staged.length > STAGED_PROTOTYPE_EVENT_CAPACITY) {
        this.staged.shift();
      }
      return;
    }
    for (const listener of this.listeners) {
      this.deliver(listener, decoded);
    }
  }

  private deliver(listener: (event: PrototypeEvent) => void, event: PrototypeEvent): void {
    try {
      listener(event);
    } catch (error) {
      // One failed consumer must not interrupt delivery to the remaining subscribers.
      logger.warn("[CTRL_PROXY] Prototype event listener failed", error);
    }
  }
}
