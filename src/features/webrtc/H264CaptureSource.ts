import type { BootedDevice } from "../../models";

export interface H264CaptureSourceOptions {
  device: BootedDevice;
  /** Called with each chunk of the raw H.264 (Annex-B) elementary stream. */
  onData: (chunk: Buffer) => void;
  /** Called when the source fails fatally after it has started. */
  onError?: (error: Error) => void;
  bitrateBps?: number;
  size?: { width: number; height: number };
}

/**
 * Common contract for a device H.264 capture source feeding the WebRTC
 * publisher. Both the segment-rotated `screenrecord` source
 * (`AndroidH264Source`) and the persistent on-device encoder source
 * (`PersistentEncoderH264Source`) satisfy it, so the stream manager can select
 * between them without caring which is in use.
 */
export interface H264CaptureSource {
  /** Start capturing; resolves once the source is producing (or has armed). */
  start(): Promise<void>;
  /** Stop capturing and release device-side resources. */
  stop(): Promise<void>;
}
