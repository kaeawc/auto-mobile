import type { BootedDevice } from "../../models";
import type { H264CaptureSource, H264CaptureSourceOptions } from "./H264CaptureSource";
import type { CaptureHintField } from "./captureHints";

export interface DeviceCaptureHandle extends H264CaptureSource {
  setHasConsumers?: (hasConsumers: boolean) => void;
}
export interface DeviceCaptureRequest {
  device: BootedDevice;
  create: (options: H264CaptureSourceOptions) => H264CaptureSource | Promise<H264CaptureSource>;
  options: H264CaptureSourceOptions;
  /** Creator defaults remain actual settings; these fields are non-binding only when joining. */
  flexibleHints?: readonly CaptureHintField[];
  /** WebRTC consumers retain this default; the relay sets its actual subscriber state. */
  hasConsumers?: boolean;
}
