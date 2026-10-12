/**
 * The narrow device-side seam the prototype tool talks through (#10568). Android
 * implements it over CtrlProxy; iOS simulators implement it over the injected prototype agent.
 * Spec validation, the variant carousel, asset upload and missing-asset re-send, the event
 * coordinator, the status store and telemetry stay shared above this interface.
 *
 * Same-id `show` is the update path on every platform that only implements this interface.
 */
import type { PrototypeAssetRequestOptions } from "../observe/android/CtrlProxyPrototypes";
import type {
  PrototypeAppearanceOverride,
  PrototypeAssetResult,
  PrototypeDismiss,
  PrototypeEvent,
  PrototypeResult,
} from "../observe/android/ctrlProxyProtocol";
import type { PrototypeAssetPutClient } from "./prototypeAssetUploader";
import type { PrototypeAssetUpload } from "./prototypeAssets";
import type { PrototypeEventSource } from "./PrototypeEventCoordinator";
import type { PrototypeSpec } from "./prototypeSpec";

export interface PrototypeShowOptions {
  timeoutMs?: number;
  /** Android logical display; omitted for the default display. Android only. */
  displayId?: number;
  /** Start a same-id show fresh instead of replacing the prototype in place. */
  reset?: boolean;
  /**
   * Pins what the system setting means for this show. The caller sets it only for a device
   * advertising `prototype_appearance_v1`; absent follows the device and sends nothing.
   */
  appearance?: PrototypeAppearanceOverride;
}

/** A device's own view of its prototype, where the platform can answer one. */
export interface PrototypeDeviceStatus {
  success: boolean;
  error?: string;
  status?: Record<string, unknown>;
}

export interface PrototypeTransport {
  show(spec: PrototypeSpec, options?: PrototypeShowOptions): Promise<PrototypeResult>;
  dismiss(target: PrototypeDismiss, timeoutMs?: number): Promise<PrototypeResult>;
  putAsset(
    asset: PrototypeAssetUpload,
    options?: PrototypeAssetRequestOptions,
  ): Promise<PrototypeAssetResult>;
  removeAsset(id: string, options?: PrototypeAssetRequestOptions): Promise<PrototypeAssetResult>;
  status(timeoutMs?: number): Promise<PrototypeDeviceStatus>;
  /** Subscribes to decoded `prototype_event` pushes; returns an unsubscribe function. */
  onEvent(listener: (event: PrototypeEvent) => void): () => void;
}

// The event coordinator keeps one subscription per device and replaces it only when the source
// object changes, so each transport must map to one stable source object.
const eventSources = new WeakMap<PrototypeTransport, PrototypeEventSource>();

/** The coordinator's view of a transport; the same object for the same transport. */
export function prototypeEventSource(transport: PrototypeTransport): PrototypeEventSource {
  let source = eventSources.get(transport);
  if (source === undefined) {
    source = { onPrototypeEvent: (listener) => transport.onEvent(listener) };
    eventSources.set(transport, source);
  }
  return source;
}

/** The asset uploader's view of a transport. */
export function prototypeAssetPutClient(transport: PrototypeTransport): PrototypeAssetPutClient {
  return { requestPutPrototypeAsset: (asset, options) => transport.putAsset(asset, options) };
}
