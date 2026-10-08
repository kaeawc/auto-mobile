import type { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import type { OverlayAssetRequestOptions } from "../observe/android/CtrlProxyOverlays";
import type {
  OverlayAssetResult,
  OverlayDismiss,
  OverlayEvent,
  OverlayResult,
  OverlayUpdate,
} from "../observe/android/ctrlProxyProtocol";
import type { OverlayAssetUpload } from "./overlayAssets";
import type { OverlaySpec } from "./overlaySpec";
import type { OverlayDeviceStatus, OverlayShowOptions, OverlayTransport } from "./OverlayTransport";

/** The CtrlProxy calls the Android overlay transport forwards to. */
export type AndroidOverlayClient = Pick<
  AndroidCtrlProxyClient,
  | "requestShowOverlay"
  | "requestUpdateOverlay"
  | "requestInspectOverlays"
  | "requestDismissOverlay"
  | "requestPutOverlayAsset"
  | "requestRemoveOverlayAsset"
  | "onOverlayEvent"
  | "supportsCommand"
>;

/**
 * Forwards every call to CtrlProxy unchanged. `update`, `inspect` and `supportsCommand` are Android-only
 * extras outside the shared interface: CtrlProxy still has `update_overlay`, and display
 * targeting is gated on a CtrlProxy capability.
 */
export class AndroidOverlayTransport implements OverlayTransport {
  constructor(private readonly client: AndroidOverlayClient) {}

  show(spec: OverlaySpec, options: OverlayShowOptions = {}): Promise<OverlayResult> {
    return this.client.requestShowOverlay(spec, options.timeoutMs, undefined, options.displayId);
  }

  update(update: OverlayUpdate, timeoutMs?: number): Promise<OverlayResult> {
    return this.client.requestUpdateOverlay(update, timeoutMs);
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
