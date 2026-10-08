/**
 * The narrow device-side seam the prototype (overlay) tool talks through (#10568). Android
 * implements it over CtrlProxy; iOS simulators implement it over the injected overlay agent.
 * Spec validation, the variant carousel, asset upload and missing-asset re-send, the event
 * coordinator, the status store and telemetry stay shared above this interface.
 *
 * Same-id `show` is the update path on every platform that only implements this interface.
 */
import type { OverlayAssetRequestOptions } from "../observe/android/CtrlProxyOverlays";
import type {
  OverlayAssetResult,
  OverlayDismiss,
  OverlayEvent,
  OverlayResult,
} from "../observe/android/ctrlProxyProtocol";
import type { OverlayAssetPutClient } from "./overlayAssetUploader";
import type { OverlayAssetUpload } from "./overlayAssets";
import type { OverlayEventSource } from "./OverlayEventCoordinator";
import type { OverlaySpec } from "./overlaySpec";

export interface OverlayShowOptions {
  timeoutMs?: number;
  /** Android logical display; omitted for the default display. Android only. */
  displayId?: number;
  /** Android only: start a same-id show fresh instead of replacing the overlay in place. */
  reset?: boolean;
}

/** A device's own view of its overlay, where the platform can answer one. */
export interface OverlayDeviceStatus {
  success: boolean;
  error?: string;
  status?: Record<string, unknown>;
}

export interface OverlayTransport {
  show(spec: OverlaySpec, options?: OverlayShowOptions): Promise<OverlayResult>;
  dismiss(target: OverlayDismiss, timeoutMs?: number): Promise<OverlayResult>;
  putAsset(
    asset: OverlayAssetUpload,
    options?: OverlayAssetRequestOptions,
  ): Promise<OverlayAssetResult>;
  removeAsset(id: string, options?: OverlayAssetRequestOptions): Promise<OverlayAssetResult>;
  status(timeoutMs?: number): Promise<OverlayDeviceStatus>;
  /** Subscribes to decoded `overlay_event` pushes; returns an unsubscribe function. */
  onEvent(listener: (event: OverlayEvent) => void): () => void;
}

// The event coordinator keeps one subscription per device and replaces it only when the source
// object changes, so each transport must map to one stable source object.
const eventSources = new WeakMap<OverlayTransport, OverlayEventSource>();

/** The coordinator's view of a transport; the same object for the same transport. */
export function overlayEventSource(transport: OverlayTransport): OverlayEventSource {
  let source = eventSources.get(transport);
  if (source === undefined) {
    source = { onOverlayEvent: (listener) => transport.onEvent(listener) };
    eventSources.set(transport, source);
  }
  return source;
}

/** The asset uploader's view of a transport. */
export function overlayAssetPutClient(transport: OverlayTransport): OverlayAssetPutClient {
  return { requestPutOverlayAsset: (asset, options) => transport.putAsset(asset, options) };
}
