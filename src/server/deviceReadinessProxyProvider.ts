import { AndroidCtrlProxyManager } from "../utils/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import type { BootedDevice } from "../models";

import { testOverrides } from "../utils/testOverrides";
import type {
  DeviceReadinessProxyDriver,
  DeviceReadinessProxyDriverProvider,
} from "../utils/testOverrides";
export type {
  DeviceReadinessProxyDriver,
  DeviceReadinessProxyDriverProvider,
} from "../utils/testOverrides";

const realProvider: DeviceReadinessProxyDriverProvider = (device) => {
  const manager = AndroidCtrlProxyManager.getInstance(device);
  return {
    resetSetupState: () => manager.resetSetupState(),
    rebindIfUnhealthy: () => manager.rebindIfUnhealthy(),
    setup: (force, perf) => manager.setup(force, perf),
    waitForConnection: () => AndroidCtrlProxyClient.getInstance(device).waitForConnection(),
    resetConnectionBudget: () => AndroidCtrlProxyClient.getInstance(device).resetConnectionBudget(),
    isInstalled: () => manager.isInstalled(),
    isVersionCompatible: () => manager.isVersionCompatible(),
  };
};

/** Resolve the readiness driver for a device through the (possibly overridden) provider. */
export function getDeviceReadinessProxyDriver(device: BootedDevice): DeviceReadinessProxyDriver {
  return (testOverrides.deviceReadinessProxyDriverProvider ?? realProvider)(device);
}

/**
 * Test seam: override the readiness driver provider process-wide. Pass `null`
 * to restore the real provider.
 */
export function setDeviceReadinessProxyDriverProviderForTesting(
  next: DeviceReadinessProxyDriverProvider | null,
): void {
  testOverrides.deviceReadinessProxyDriverProvider = next;
}
