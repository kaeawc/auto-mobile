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
    switch (platform) {
      case "android":
        AndroidCtrlProxyClient.resumeAfterDeviceStart(deviceId);
        return;
      case "ios":
        IOSCtrlProxyClient.resumeAfterDeviceStart(deviceId);
        return;
      case "watchos":
        // A watch has no CtrlProxy client yet (#14899), so there is nothing to re-admit.
        return;
    }
  }

  async retireForShutdown(platform: Platform, deviceId: string): Promise<void> {
    switch (platform) {
      case "android":
        AndroidCtrlProxyClient.retireForShutdown(deviceId);
        return;
      case "ios":
        await IOSCtrlProxyClient.retireInstance(deviceId);
        return;
      case "watchos":
        // A watch has no CtrlProxy client yet (#14899), so there is nothing to fence.
        return;
    }
  }
}

export const ctrlProxyClientLifecycle: CtrlProxyClientLifecycle =
  new DefaultCtrlProxyClientLifecycle();
