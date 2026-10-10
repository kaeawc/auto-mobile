import type { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import type { PrototypeAssetRequestOptions } from "../observe/android/CtrlProxyPrototypes";
import type {
  PrototypeAssetResult,
  PrototypeDismiss,
  PrototypeEvent,
  PrototypeResult,
} from "../observe/android/ctrlProxyProtocol";
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
  | "requestShowPrototype"
  | "requestInspectPrototypes"
  | "requestDismissPrototype"
  | "requestPutPrototypeAsset"
  | "requestRemovePrototypeAsset"
  | "onPrototypeEvent"
  | "supportsCommand"
>;

/**
 * Forwards every call to CtrlProxy unchanged. `inspect` and `supportsCommand` are Android-only extras outside
 * the shared interface: display targeting is gated on a CtrlProxy capability.
 */
export class AndroidPrototypeTransport implements PrototypeTransport {
  constructor(private readonly client: AndroidPrototypeClient) {}

  show(spec: PrototypeSpec, options: PrototypeShowOptions = {}): Promise<PrototypeResult> {
    return this.client.requestShowPrototype(
      spec,
      options.timeoutMs,
      undefined,
      options.displayId,
      options.reset,
    );
  }

  inspect(timeoutMs?: number): Promise<PrototypeResult> {
    return this.client.requestInspectPrototypes(timeoutMs);
  }

  dismiss(target: PrototypeDismiss, timeoutMs?: number): Promise<PrototypeResult> {
    return this.client.requestDismissPrototype(target, timeoutMs);
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
