import type { Platform } from "../../models";
import { AndroidCtrlProxyClient } from "./android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "./ios/IOSCtrlProxyClient";

/**
 * Platform-dispatching lifecycle entry point for the per-device CtrlProxy clients (#11847).
 * Callers that only know a device's platform use this instead of branching on it to pick
 * the right static; the per-platform vocabulary stays behind the two implementations.
 */
export interface CtrlProxyClientLifecycle {
  /** Re-admit a device whose client was retired for shutdown (an explicit start is a fresh start). */
  resumeAfterDeviceStart(platform: Platform, deviceId: string): void;
  /** Fence the device's client before its runner stops, so closing cannot trigger a reconnect. */
  retireForShutdown(platform: Platform, deviceId: string): Promise<void>;
}

class DefaultCtrlProxyClientLifecycle implements CtrlProxyClientLifecycle {
  resumeAfterDeviceStart(platform: Platform, deviceId: string): void {
    if (platform === "android") {
      AndroidCtrlProxyClient.resumeAfterDeviceStart(deviceId);
    } else {
      IOSCtrlProxyClient.resumeAfterDeviceStart(deviceId);
    }
  }

  async retireForShutdown(platform: Platform, deviceId: string): Promise<void> {
    if (platform === "android") {
      AndroidCtrlProxyClient.retireForShutdown(deviceId);
    } else {
      await IOSCtrlProxyClient.retireInstance(deviceId);
    }
  }
}

export const ctrlProxyClientLifecycle: CtrlProxyClientLifecycle =
  new DefaultCtrlProxyClientLifecycle();
