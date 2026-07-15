import { ActionableError } from "../../models";
import type { H264CaptureSource, H264CaptureSourceOptions } from "./H264CaptureSource";
import { createAndroidH264CaptureSource } from "./androidH264CaptureSourceFactory";
import { IosH264Source } from "./IosH264Source";

/**
 * Build a capture source for a device. `jarPath` is the pre-resolved Android
 * persistent-encoder jar (or `null` to force `screenrecord`); it is resolved
 * once at stream start, off the frame path, and ignored for non-Android devices.
 */
export type H264CaptureSourceFactory = (
  options: H264CaptureSourceOptions,
  jarPath: string | null
) => H264CaptureSource;

export const createH264CaptureSource: H264CaptureSourceFactory = (options, jarPath) => {
  if (options.device.platform === "android") {
    return createAndroidH264CaptureSource(options, jarPath);
  }
  if (options.device.platform === "ios") {
    if (options.audioEnabled) {
      throw new ActionableError("WebRTC audio capture is currently supported only on Android.");
    }
    return new IosH264Source(options);
  }
  throw new ActionableError(`WebRTC streaming does not support ${options.device.platform} devices.`);
};
