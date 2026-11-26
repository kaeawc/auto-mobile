import { prototypePlatformOutcomesUnsupportedMessage } from "./prototypePlatformOutcomes";
import type { PrototypePlatformOutcomeRequest } from "../observe/android/ctrlProxyProtocol";
import type { PrototypeJson } from "./prototypeJson";
import { prototypePlatformSimulationUnsupportedMessage } from "./prototypePlatformSimulation";
import type { PrototypePatchReply, PrototypePatchRequest } from "./prototypePatchWire";
import type { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import type { PrototypeAssetRequestOptions } from "../observe/android/CtrlProxyPrototypes";
import type { PrototypeMediaRequestOptions } from "../observe/android/CtrlProxyPrototypeMedia";
import type {
  PrototypeMediaTransportClient,
  PrototypeMediaTransportMessage,
  PrototypeMediaTransportResult,
} from "./prototypeMediaUpload";
import type {
  PrototypeAssetResult,
  PrototypeDismiss,
  PrototypeEvent,
  PrototypeInspectOptions,
  PrototypeResult,
} from "../observe/android/ctrlProxyProtocol";
import { ActionableError } from "../../models/ActionableError";
import { withParsedAppearance } from "./prototypeAppearance";
import { prototypeClearStorageUnsupportedMessage } from "./prototypeStorage";
import type { PrototypeAssetUpload } from "./prototypeAssets";
import type { PrototypeSpec } from "./prototypeSpec";
import type {
  PrototypeDeviceStatus,
  PrototypeShowOptions,
  PrototypeTransport,
} from "./PrototypeTransport";

/** The CtrlProxy calls the Android prototype transport forwards to. */
export type AndroidPrototypeClient = Pick<
  AndroidCtrlProxyClient,
  | "requestSavePrototype"
  | "requestListSavedPrototypes"
  | "requestPinSavedPrototype"
  | "requestDeleteSavedPrototype"
  | "requestShowPrototype"
  | "requestInspectPrototypes"
  | "requestPatchPrototype"
  | "requestDismissPrototype"
  | "requestPutPrototypeAsset"
  | "requestRemovePrototypeAsset"
  | "onPrototypeEvent"
  | "supportsCommand"
> &
  Partial<
    Pick<
      AndroidCtrlProxyClient,
      | "attachPrototypeRequestHost"
      | "attachPrototypeChannelHost"
      | "requestClearPrototypeStorage"
      | "requestAdvancePrototypeClock"
      | "requestQueuePrototypeCallOutcome"
      | "requestSimulatePrototypePlatform"
      | "requestPrototypeMediaMessage"
    >
  >;

/**
 * Forwards every call to CtrlProxy unchanged. `inspect` and `supportsCommand` are Android-only extras outside
 * the shared interface: display targeting is gated on a CtrlProxy capability.
 */
export class AndroidPrototypeTransport
  implements PrototypeTransport, PrototypeMediaTransportClient
{
  constructor(private readonly client: AndroidPrototypeClient) {}

  async show(spec: PrototypeSpec, options: PrototypeShowOptions = {}): Promise<PrototypeResult> {
    return withParsedAppearance(
      await this.client.requestShowPrototype(spec, options.timeoutMs, undefined, {
        displayId: options.displayId,
        reset: options.reset,
        appearance: options.appearance,
        replaceOthers: options.replaceOthers,
        locale: spec.strings ? options.locale : undefined,
      }),
    );
  }

  patch(patch: PrototypePatchRequest, timeoutMs?: number): Promise<PrototypePatchReply> {
    return this.client.requestPatchPrototype(patch, timeoutMs);
  }

  inspect(timeoutMs?: number, options?: PrototypeInspectOptions): Promise<PrototypeResult> {
    return this.client.requestInspectPrototypes(timeoutMs, undefined, options);
  }

  /** Saved prototypes are Android-only extras outside PrototypeTransport. */
  save(
    save: { spec: PrototypeSpec; label: string; icon?: string },
    timeoutMs?: number,
  ): Promise<PrototypeResult> {
    return this.client.requestSavePrototype(save, timeoutMs);
  }

  listSaved(timeoutMs?: number): Promise<PrototypeResult> {
    return this.client.requestListSavedPrototypes(timeoutMs);
  }

  pinSaved(id: string, icon?: string, timeoutMs?: number): Promise<PrototypeResult> {
    return this.client.requestPinSavedPrototype(id, icon, timeoutMs);
  }

  deleteSaved(id: string, timeoutMs?: number): Promise<PrototypeResult> {
    return this.client.requestDeleteSavedPrototype(id, timeoutMs);
  }

  dismiss(target: PrototypeDismiss, timeoutMs?: number): Promise<PrototypeResult> {
    return this.client.requestDismissPrototype(target, timeoutMs);
  }

  advanceClock(id: string, advanceTimeMs: number, timeoutMs?: number): Promise<PrototypeResult> {
    if (!this.client.requestAdvancePrototypeClock) {
      throw new ActionableError("Update the connected CtrlProxy to simulate prototype timers");
    }
    return this.client.requestAdvancePrototypeClock(id, advanceTimeMs, timeoutMs);
  }

  queueCallOutcome(
    request: PrototypePlatformOutcomeRequest,
    timeoutMs?: number,
  ): Promise<PrototypeResult> {
    if (!this.client.requestQueuePrototypeCallOutcome) {
      throw new ActionableError(prototypePlatformOutcomesUnsupportedMessage());
    }
    return this.client.requestQueuePrototypeCallOutcome(request, timeoutMs);
  }

  simulatePlatformEvent(
    id: string,
    event: string,
    data: Record<string, PrototypeJson>,
    timeoutMs?: number,
  ): Promise<PrototypeResult> {
    if (!this.client.requestSimulatePrototypePlatform) {
      throw new ActionableError(prototypePlatformSimulationUnsupportedMessage());
    }
    return this.client.requestSimulatePrototypePlatform({ id, event, data }, timeoutMs);
  }

  /** Wipes the values CtrlProxy stored for `id` (#12522); needs prototype_storage_v1. */
  clearStorage(id: string, timeoutMs?: number): Promise<PrototypeResult> {
    if (!this.client.requestClearPrototypeStorage) {
      throw new ActionableError(prototypeClearStorageUnsupportedMessage("android"));
    }
    return this.client.requestClearPrototypeStorage(id, timeoutMs);
  }

  putAsset(
    asset: PrototypeAssetUpload,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult> {
    return this.client.requestPutPrototypeAsset(asset, options);
  }

  removeAsset(id: string, options?: PrototypeAssetRequestOptions): Promise<PrototypeAssetResult> {
    return this.client.requestRemovePrototypeAsset(id, options);
  }

  /** One chunked media upload message (#14254), so the uploader can stream through CtrlProxy. */
  sendPrototypeMediaMessage(
    message: PrototypeMediaTransportMessage,
    options?: PrototypeMediaRequestOptions,
  ): Promise<PrototypeMediaTransportResult> {
    if (!this.client.requestPrototypeMediaMessage) {
      throw new ActionableError(
        `${message.type}: this CtrlProxy client cannot upload prototype media; update the connected CtrlProxy.`,
      );
    }
    return this.client.requestPrototypeMediaMessage(message, options);
  }

  /** CtrlProxy has no prototype status request; the tool's status action is host-local. */
  async status(): Promise<PrototypeDeviceStatus> {
    return {
      success: false,
      error: "CtrlProxy has no prototype status request; use the host-local status action.",
    };
  }

  onEvent(listener: (event: PrototypeEvent) => void): () => void {
    return this.client.onPrototypeEvent(listener);
  }

  supportsCommand(name: string): Promise<boolean> {
    return this.client.supportsCommand(name);
  }
}
