import type { PrototypeShowOverrides } from "../../prototype/PrototypeTransport";
import {
  prototypePatchReplyFields,
  prototypePatchUnsupportedMessage,
  type PrototypePatchRequest,
  type PrototypePatchReply,
} from "../../prototype/prototypePatchWire";
import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import { z } from "zod";
import { ActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import {
  actionSchema,
  prototypeHasStack,
  prototypeStackUnsupportedMessage,
  prototypeSpecSchema,
  prototypeJsonObjectSchema,
  type PrototypeSpec,
} from "../../prototype/prototypeSpec";
import {
  DEFAULT_PROTOTYPE_ASSET_TIMEOUT_MS,
  prototypeAssetIdProblem,
  prototypeAssetUploadProblem,
  type PrototypeAssetUpload,
} from "../../prototype/prototypeAssets";
import { validatePrototypeSpec } from "../../prototype/prototypeValidation";
import {
  isPrototypeDataWriteName,
  prototypeDataWriteOf,
} from "../../prototype/prototypeDataWriteEvent";
import { errorMessage } from "../../../utils/describeUnknownError";
import { sendCommand, type SendCommandOptions } from "../DeviceServiceUtils";
import type { DelegateContext } from "./types";
import {
  ctrlProxyRequests,
  PROTOTYPE_SAVED_CAPABILITY,
  isSavedPrototypeErrorCode,
  type SavePrototypeMessage,
  type PinSavedPrototypeMessage,
  type ListSavedPrototypesMessage,
  type DeleteSavedPrototypeMessage,
  PROTOTYPE_DISPLAY_CAPABILITY,
  PROTOTYPE_STACK_CAPABILITY,
  PROTOTYPE_MULTI_SURFACE_CAPABILITY,
  PROTOTYPE_PATCH_CAPABILITY,
  type PatchPrototypeMessage,
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
export function prototypeMultiSurfaceUnsupportedMessage(): string {
  return `show_prototype: the connected CtrlProxy does not advertise ${PROTOTYPE_MULTI_SURFACE_CAPABILITY}, so it cannot honour replaceOthers:false. Nothing was shown. Update the connected CtrlProxy, or omit replaceOthers to replace the other prototypes.`;
}

/** Shared by the client transport guard and the tool-level refusal. */
export function prototypeInspectUnsupportedMessage(): string {
  return `inspect_prototypes: the connected CtrlProxy does not advertise ${PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY}, so it cannot report the prototypes it is showing or replay events buffered while no host was connected; update the connected CtrlProxy.`;
}

/** Shared refusal for saved prototype requests. */
export function prototypeSavedUnsupportedMessage(type: string): string {
  return `${type}: the connected CtrlProxy does not advertise ${PROTOTYPE_SAVED_CAPABILITY}; update the connected CtrlProxy.`;
}
const shortcutUpdateSchema = z.enum(["updated", "rate_limited"]);
const savedInfoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  replaced: z.boolean(),
  shortcut: z.unknown().optional(),
});
const pinInfoSchema = z.object({
  id: z.string(),
  status: z.enum(["requested", "already_pinned"]),
  shortcut: z.unknown().optional(),
});
const savedEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  slug: z.string(),
  savedAt: z.number().finite(),
  pinned: z.boolean(),
});
/** Keeps well-formed saved reply fields; a malformed list is omitted as a whole. */
export function prototypeSavedReplyFields(
  reply: unknown,
): Pick<PrototypeResult, "saved" | "savedPrototypes" | "errorCode" | "pin"> {
  const envelope = z
    .object({
      saved: z.unknown().optional(),
      pin: z.unknown().optional(),
      savedPrototypes: z.unknown().optional(),
      errorCode: z.unknown().optional(),
    })
    .safeParse(reply);
  if (!envelope.success) {
    return {};
  }
  const saved = savedInfoSchema.safeParse(envelope.data.saved);
  const pin = pinInfoSchema.safeParse(envelope.data.pin);
  const pinShortcut = shortcutUpdateSchema.safeParse(pin.success ? pin.data.shortcut : undefined);
  const shortcut = shortcutUpdateSchema.safeParse(saved.success ? saved.data.shortcut : undefined);
  const savedPrototypes = z.array(savedEntrySchema).safeParse(envelope.data.savedPrototypes);
  if (envelope.data.savedPrototypes !== undefined && !savedPrototypes.success) {
    logger.warn("[CTRL_PROXY] Dropping malformed savedPrototypes", savedPrototypes.error);
  }
  return {
    ...(pin.success
      ? {
          pin: {
            id: pin.data.id,
            status: pin.data.status,
            ...(pinShortcut.success ? { shortcut: pinShortcut.data } : {}),
          },
        }
      : {}),
    ...(saved.success
      ? {
          saved: {
            id: saved.data.id,
            slug: saved.data.slug,
            replaced: saved.data.replaced,
            ...(shortcut.success ? { shortcut: shortcut.data } : {}),
          },
        }
      : {}),
    ...(savedPrototypes.success ? { savedPrototypes: savedPrototypes.data } : {}),
    ...(isSavedPrototypeErrorCode(envelope.data.errorCode)
      ? { errorCode: envelope.data.errorCode }
      : {}),
  };
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

/** Optional navigation snapshots from newer devices; malformed entries are ignored. */
const stackEntrySchema = z
  .object({
    path: z.array(z.string().min(1)).min(1).max(32),
    depth: z.number().int().min(1).max(32),
  })
  .refine((entry) => entry.path.length === entry.depth);
export function parsePrototypeStacks(value: unknown): PrototypeEvent["stacks"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([id, entry]) => {
    const parsed = stackEntrySchema.safeParse(entry);
    return id && parsed.success ? [[id, parsed.data] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}
export const prototypeStacksSchema = z.unknown().optional().transform(parsePrototypeStacks);

/** One `prototype_event` push of a kind this host knows. */
export const prototypeEventSchema = prototypeEventEnvelopeSchema
  .extend({
    kind: z.enum(PROTOTYPE_EVENT_KINDS),
    validity: z.record(z.string().min(1), z.boolean()).optional(),
    keys: z.array(z.string().min(1)).min(1).max(8).optional(),
    name: z.string().nullable(),
    payload: actionSchema.options[0].shape.payload.unwrap(),
    context: prototypeJsonObjectSchema.optional(),
    contextTruncated: z.literal(true).optional(),
    state: prototypeSpecSchema.shape.state.unwrap(),
    pages: z.record(z.string().min(1), z.number().int().nonnegative().max(2147483647)).default({}),
    stacks: prototypeStacksSchema,
  })
  .superRefine((event, context) => {
    // A data write is itself a change (#12519): it may omit validity but must carry its payload.
    if (event.kind === "change" && isPrototypeDataWriteName(event.name)) {
      if (prototypeDataWriteOf(event) === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["payload"],
          message: "Invalid data write for a change event",
        });
      }
      return;
    }
    const field =
      event.kind === "change"
        ? "validity"
        : event.kind === "validation_failed"
          ? "keys"
          : undefined;
    if (field !== undefined && event[field] === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `Required for ${event.kind} events`,
      });
    }
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

/** Match cached IDs throughout JSON; asset and image values identify uncached references too. */
function collectPrototypeStrings(
  value: unknown,
  strings: Set<string>,
  references: Set<string>,
  assetValue = false,
  arbitraryJson = false,
): void {
  if (typeof value === "string") {
    strings.add(value);
    if (assetValue && !arbitraryJson) {
      references.add(value);
    }
  } else if (typeof value === "object" && value !== null) {
    // Object.entries also traverses array elements without changing subtree context.
    for (const [key, child] of Object.entries(value)) {
      collectPrototypeStrings(
        child,
        strings,
        references,
        assetValue || ["asset", "image"].includes(key),
        arbitraryJson || ["state", "payload"].includes(key),
      );
    }
  }
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
   * An options object also carries replaceOthers; only false is sent, capability-gated before dispatch.
   */
  async requestShowPrototype(
    spec: PrototypeSpec,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
    displayId?: number,
    reset?: boolean,
    appearance?: PrototypeAppearanceOverride | PrototypeShowOverrides,
  ): Promise<PrototypeResult> {
    this.validateSpec(spec);
    const overrides = typeof appearance === "string" ? { appearance } : appearance;
    const target = displayId === undefined || displayId === 0 ? undefined : displayId;
    return this.request(
      ctrlProxyRequests.showPrototype({
        requestId: "",
        spec,
        displayId: target,
        reset,
        appearance: overrides?.appearance,
        replaceOthers: overrides?.replaceOthers,
      }),
      timeoutMs,
      perf,
    );
  }

  /** Assets must already be uploaded to the device with requestPutPrototypeAsset. */
  async requestSavePrototype(
    save: { spec: PrototypeSpec; label: string; icon?: string },
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    this.validateSpec(save.spec);
    if (typeof save.label !== "string" || save.label.length === 0 || save.label.length > 120) {
      throw new ActionableError(
        "Invalid saved prototype label: expected a non-empty string of at most 120 characters",
      );
    }
    if (
      save.icon !== undefined &&
      (typeof save.icon !== "string" || prototypeAssetIdProblem(save.icon) !== null)
    ) {
      throw new ActionableError(
        "Invalid saved prototype icon: expected a valid asset id; explicit nulls are rejected",
      );
    }
    const reply = await this.request(
      ctrlProxyRequests.savePrototype({ requestId: "", ...save }),
      timeoutMs,
      perf,
    );
    if (reply.success && !reply.error) {
      await this.mirrorSave(save, reply);
    }
    return reply;
  }
  async requestPinSavedPrototype(
    id: string,
    icon?: string,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    if (typeof id !== "string" || id.length === 0) {
      throw new ActionableError("Invalid saved prototype id: expected a non-empty string");
    }
    if (
      icon !== undefined &&
      (typeof icon !== "string" || prototypeAssetIdProblem(icon) !== null)
    ) {
      throw new ActionableError(
        "Invalid saved prototype icon: expected a valid asset id; explicit nulls are rejected",
      );
    }
    return this.request(
      ctrlProxyRequests.pinSavedPrototype({ requestId: "", id, icon }),
      timeoutMs,
      perf,
    );
  }

  requestListSavedPrototypes(
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    return this.request(ctrlProxyRequests.listSavedPrototypes({ requestId: "" }), timeoutMs, perf);
  }
  async requestDeleteSavedPrototype(
    id: string,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<PrototypeResult> {
    if (typeof id !== "string" || id.length === 0) {
      throw new ActionableError("Invalid saved prototype id: expected a non-empty string");
    }
    const reply = await this.request(
      ctrlProxyRequests.deleteSavedPrototype({ requestId: "", id }),
      timeoutMs,
      perf,
    );
    const recorder = this.context.savedPrototypeMirror;
    if (reply.success && !reply.error && recorder) {
      try {
        await recorder.mirror.remove(recorder.serial, id);
      } catch (error) {
        logger.warn(`[CTRL_PROXY] Failed to remove saved prototype mirror ${id}`, error);
      }
    }
    return reply;
  }

  private async mirrorSave(
    save: { spec: PrototypeSpec; label: string; icon?: string },
    reply: PrototypeResult,
  ): Promise<void> {
    const recorder = this.context.savedPrototypeMirror;
    if (!recorder) {
      return;
    }
    try {
      const strings = new Set<string>();
      const references = new Set<string>();
      collectPrototypeStrings(save.spec, strings, references);
      if (save.icon !== undefined) {
        references.add(save.icon);
      }
      const cached = this.context.prototypeAssetCache;
      let known: ReadonlySet<string> = new Set<string>();
      try {
        if (cached) {
          known = await cached.cache.ids(cached.serial);
        }
      } catch (error) {
        logger.warn(
          `[CTRL_PROXY] Saved prototype ${reply.saved?.id ?? save.spec.id} cannot list cached assets`,
          error,
        );
      }
      const ids = new Set([...strings].filter((id) => known.has(id)));
      for (const id of references) {
        ids.add(id);
      }
      const assets = await Promise.all(
        [...ids].map(async (id) => {
          let asset: PrototypeAssetUpload | undefined;
          try {
            asset = cached ? await cached.cache.get(cached.serial, id) : undefined;
          } catch (error) {
            logger.warn(
              `[CTRL_PROXY] Saved prototype ${reply.saved?.id ?? save.spec.id} mirror cannot read asset ${id}`,
              error,
            );
            return { id };
          }
          if (!asset) {
            logger.warn(
              `[CTRL_PROXY] Saved prototype ${reply.saved?.id ?? save.spec.id} mirror missing asset ${id}`,
            );
          }
          return asset ? { ...asset, bytes: asset.bytes.slice() } : { id };
        }),
      );
      await recorder.mirror.record(recorder.serial, {
        id: reply.saved?.id ?? save.spec.id,
        ...save,
        assets,
      });
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to mirror saved prototype ${save.spec.id}`, error);
    }
  }

  async requestPatchPrototype(
    patch: PrototypePatchRequest,
    timeoutMs = 5000,
    perf?: PerformanceTracker,
  ): Promise<PrototypePatchReply> {
    let dispatched = false;
    let unconfirmed = false;
    try {
      const result = await this.request(
        ctrlProxyRequests.patchPrototype({ requestId: "", ...patch }),
        timeoutMs,
        perf,
        {
          onDispatch: () => {
            dispatched = true;
          },
          timeoutError: (timeout) => {
            unconfirmed = true;
            return {
              success: false,
              totalTimeMs: timeout,
              error: `prototype_result timed out after ${timeout}ms`,
            };
          },
        },
      );
      const rest = { ...result };
      delete rest.revision;
      delete rest.conflict;
      return {
        ...rest,
        ...prototypePatchReplyFields(result),
        delivery: !dispatched ? "unsent" : unconfirmed ? "indeterminate" : "answered",
      };
    } catch (error) {
      logger.warn("[CTRL_PROXY] Prototype patch transport failed", error);
      rethrowRealCtrlProxyWebSocketInTestError(error);
      return {
        success: false,
        delivery: dispatched ? "indeterminate" : "unsent",
        error: errorMessage(error),
      };
    }
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
    const snapshot = { ...asset, bytes: Uint8Array.from(asset.bytes) };
    const reply = await this.sendAssetRequest(
      ctrlProxyRequests.putPrototypeAsset({
        requestId: "",
        id: asset.id,
        mimeType: asset.mimeType,
        dataBase64,
      }),
      `Upload of prototype asset '${asset.id}'`,
      options,
    );
    if (reply.success && !reply.error) {
      const cached = this.context.prototypeAssetCache;
      if (cached) {
        try {
          await cached.cache.put(cached.serial, snapshot);
        } catch (error) {
          logger.warn(`[CTRL_PROXY] Failed to cache prototype asset ${asset.id}`, error);
        }
      }
    }
    return reply;
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
    const reply = await this.sendAssetRequest(
      ctrlProxyRequests.removePrototypeAsset({ requestId: "", id }),
      `Removal of prototype asset '${id}'`,
      options,
    );
    if (reply.success && !reply.error) {
      const cached = this.context.prototypeAssetCache;
      if (cached) {
        try {
          await cached.cache.remove(cached.serial, id);
        } catch (error) {
          logger.warn(`[CTRL_PROXY] Failed to remove cached prototype asset ${id}`, error);
        }
      }
    }
    return reply;
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
    message:
      | ShowPrototypeMessage
      | DismissPrototypeMessage
      | InspectPrototypesMessage
      | PatchPrototypeMessage
      | PinSavedPrototypeMessage
      | SavePrototypeMessage
      | ListSavedPrototypesMessage
      | DeleteSavedPrototypeMessage,
    timeoutMs: number,
    perf?: PerformanceTracker,
    deliveryOptions: Pick<SendCommandOptions<PrototypeResult>, "onDispatch" | "timeoutError"> = {},
  ): Promise<PrototypeResult> {
    const connected = perf
      ? await perf.track("ensureConnected", () => this.context.ensureConnected(perf))
      : await this.context.ensureConnected();
    if (!connected) {
      return { success: false, error: "Not connected", totalTimeMs: 0 };
    }
    this.requirePrototypeSupport(message);
    const type = message.type;
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
      ...deliveryOptions,
    });
  }

  private requirePrototypeSupport(
    message:
      | ShowPrototypeMessage
      | DismissPrototypeMessage
      | InspectPrototypesMessage
      | PatchPrototypeMessage
      | PinSavedPrototypeMessage
      | SavePrototypeMessage
      | ListSavedPrototypesMessage
      | DeleteSavedPrototypeMessage,
  ): void {
    const supports = (command: string) => this.context.isCommandSupported?.(command);
    if (message.type === "patch_prototype" && supports(PROTOTYPE_PATCH_CAPABILITY) !== true) {
      throw new ActionableError(prototypePatchUnsupportedMessage("android"));
    }
    if (
      message.type === "show_prototype" &&
      prototypeHasStack(message.spec) &&
      supports(PROTOTYPE_STACK_CAPABILITY) !== true
    ) {
      throw new ActionableError(prototypeStackUnsupportedMessage("android"));
    }
    this.requireMultiSurfaceSupport(message, supports);
    const type = message.type;
    if (
      [
        "save_prototype",
        "list_saved_prototypes",
        "delete_saved_prototype",
        "pin_saved_prototype",
      ].includes(type) &&
      supports(PROTOTYPE_SAVED_CAPABILITY) !== true
    ) {
      throw new ActionableError(prototypeSavedUnsupportedMessage(type));
    }
    if (supports(type) === false) {
      throw new ActionableError(
        `${type}: this CtrlProxy build does not support prototypes; update the connected CtrlProxy.`,
      );
    }
    if (
      message.type === "inspect_prototypes" &&
      supports(PROTOTYPE_PERSISTENCE_REPLAY_CAPABILITY) !== true
    ) {
      throw new ActionableError(prototypeInspectUnsupportedMessage());
    }
    if (message.type === "show_prototype") {
      this.requirePrototypeDisplaySupport(message);
    }
  }

  private requirePrototypeDisplaySupport(message: ShowPrototypeMessage): void {
    if (
      message.displayId !== undefined &&
      this.context.isCommandSupported?.(PROTOTYPE_DISPLAY_CAPABILITY) !== true
    ) {
      // Never send displayId to a device that would ignore it and show on the default display.
      throw new ActionableError(prototypeDisplayUnsupportedMessage(message.displayId));
    }
  }

  private requireMultiSurfaceSupport(
    message: { readonly type: string; readonly replaceOthers?: boolean },
    supports: (command: string) => boolean | undefined,
  ): void {
    if (
      message.type === "show_prototype" &&
      message.replaceOthers === false &&
      supports(PROTOTYPE_MULTI_SURFACE_CAPABILITY) !== true
    ) {
      throw new ActionableError(prototypeMultiSurfaceUnsupportedMessage());
    }
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
