import { ActionableError } from "../../models";
import type { H264CaptureSource, H264CaptureSourceOptions } from "./H264CaptureSource";
import { createAndroidH264CaptureSource } from "./androidH264CaptureSourceFactory";
import { IosH264Source } from "./IosH264Source";

export type H264CaptureSourceFactory = (options: H264CaptureSourceOptions) => H264CaptureSource;

export const createH264CaptureSource: H264CaptureSourceFactory = options => {
  if (options.device.platform === "android") {
    return createAndroidH264CaptureSource(options);
  }
  if (options.device.platform === "ios") {
    return new IosH264Source(options);
  }
  throw new ActionableError(`WebRTC streaming does not support ${options.device.platform} devices.`);
};
