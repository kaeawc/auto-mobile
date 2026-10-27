import {
  type AdbClientFactory,
  defaultAdbClientFactory,
} from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { assertAndroidCtrlProxyDevice } from "./androidCtrlProxyDeviceGuard";
import type { BootedDevice } from "../../../models";
import type { AndroidCtrlProxy } from "./AndroidCtrlProxy";
import { AndroidCtrlProxyClient } from "./AndroidCtrlProxyClient";

/**
 * The default per-device CtrlProxy client for collaborators that accept an injected one (#11806).
 * One shared default instead of a `getInstance` lambda per collaborator.
 */
export function androidCtrlProxyClientFor(device: BootedDevice): AndroidCtrlProxy {
  return AndroidCtrlProxyClient.getInstance(device);
}

/** Keep Android resolution eager; other platforms refuse only on accidental use. */
export function androidCtrlProxyClientForPlatform(
  device: BootedDevice,
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
): AndroidCtrlProxy {
  if (device.platform === "android") {
    return AndroidCtrlProxyClient.getInstance(device, adbFactory);
  }
  // The empty target is never read: every Android property is intercepted and refused.
  return new Proxy({} as AndroidCtrlProxy, {
    get(_target, property) {
      if (property === "then" || typeof property === "symbol") {
        return undefined;
      }
      assertAndroidCtrlProxyDevice(device);
    },
  });
}
