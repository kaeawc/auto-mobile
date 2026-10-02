import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios/IOSCtrlProxyClient";

// Registry-only cleanup avoids resetInstances()' fire-and-forget adb/socket work
// and preserves PortManager clocks and allocations installed by beforeAll.
export function clearCtrlProxyRegistries(): void {
  AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
  IOSCtrlProxyClient.clearInstanceRegistryForTesting();
}
