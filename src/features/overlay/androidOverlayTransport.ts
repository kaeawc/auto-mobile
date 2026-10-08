import type { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import type { OverlayAssetRequestOptions } from "../observe/android/CtrlProxyOverlays";
import type {
  OverlayAssetResult,
  OverlayDismiss,
  OverlayEvent,
  OverlayResult,
} from "../observe/android/ctrlProxyProtocol";
import type { OverlayAssetUpload } from "./overlayAssets";
import type { OverlaySpec } from "./overlaySpec";
import type { OverlayDeviceStatus, OverlayShowOptions, OverlayTransport } from "./OverlayTransport";

/** The CtrlProxy calls the Android overlay transport forwards to. */
export type AndroidOverlayClient = Pick<
  AndroidCtrlProxyClient,
  | "requestShowOverlay"
  | "requestInspectOverlays"
  | "requestDismissOverlay"
  | "requestPutOverlayAsset"
  | "requestRemoveOverlayAsset"
  | "onOverlayEvent"
  | "supportsCommand"
>;

/**
 * Forwards every call to CtrlProxy unchanged. `inspect` and `supportsCommand` are Android-only extras outside
 * the shared interface: display targeting is gated on a CtrlProxy capability.
 */
export class AndroidOverlayTransport implements OverlayTransport {
  constructor(private readonly client: AndroidOverlayClient) {}

  show(spec: OverlaySpec, options: OverlayShowOptions = {}): Promise<OverlayResult> {
    return this.client.requestShowOverlay(
      spec,
      options.timeoutMs,
      undefined,
      options.displayId,
      options.reset,
    );
  }

  inspect(timeoutMs?: number): Promise<OverlayResult> {
    return this.client.requestInspectOverlays(timeoutMs);
  }

  dismiss(target: OverlayDismiss, timeoutMs?: number): Promise<OverlayResult> {
    return this.client.requestDismissOverlay(target, timeoutMs);
  }

  putAsset(
    asset: OverlayAssetUpload,
    options?: OverlayAssetRequestOptions,
  ): Promise<OverlayAssetResult> {
    return this.client.requestPutOverlayAsset(asset, options);
  }

  removeAsset(id: string, options?: OverlayAssetRequestOptions): Promise<OverlayAssetResult> {
    return this.client.requestRemoveOverlayAsset(id, options);
  }

  /** CtrlProxy has no overlay status request; the tool's status action is host-local. */
  async status(): Promise<OverlayDeviceStatus> {
    return {
      success: false,
      error: "CtrlProxy has no overlay status request; use the host-local status action.",
    };
  }

  onEvent(listener: (event: OverlayEvent) => void): () => void {
    return this.client.onOverlayEvent(listener);
  }

  supportsCommand(name: string): Promise<boolean> {
    return this.client.supportsCommand(name);
  }
}
