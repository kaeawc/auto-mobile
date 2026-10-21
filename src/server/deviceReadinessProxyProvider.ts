import { AndroidCtrlProxyManager } from "../ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import type { BootedDevice } from "../models";

import { testOverrides } from "../utils/testOverrides";
import type {
  DeviceReadinessProxyDriver,
  DeviceReadinessProxyDriverProvider,
} from "../utils/testOverrides";
export type { DeviceReadinessProxyDriver } from "../utils/testOverrides";

const realProvider: DeviceReadinessProxyDriverProvider = (device) => {
  const manager = AndroidCtrlProxyManager.getInstance(device);
  return {
    resetSetupState: () => manager.resetSetupState(),
    rebindIfUnhealthy: () => manager.rebindIfUnhealthy(),
    forceRestartProcess: () => manager.forceRestartProcess(),
    verifyServiceReady: () =>
      AndroidCtrlProxyClient.getInstance(device).verifyServiceReady?.(1, 0) ??
      Promise.resolve(true),
    setup: (force, perf) => manager.setup(force, perf),
    waitForConnection: () => AndroidCtrlProxyClient.getInstance(device).waitForConnection(),
    resetConnectionBudget: () => AndroidCtrlProxyClient.getInstance(device).resetConnectionBudget(),
    isInstalled: () => manager.isInstalled(),
    isVersionCompatible: () => manager.isVersionCompatible(),
  };
};

/**
 * Resolve the readiness driver for a device through the provider. Tests replace it with
 * `testOverrides.deviceReadinessProxyDriverProvider` (the shared preload installs a no-op).
 */
export function getDeviceReadinessProxyDriver(device: BootedDevice): DeviceReadinessProxyDriver {
  return (testOverrides.deviceReadinessProxyDriverProvider ?? realProvider)(device);
}
