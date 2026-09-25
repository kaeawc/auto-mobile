import type { BootedDevice } from "../models";
import type { PerformanceTracker } from "./PerformanceTracker";
import type { ProxySetupResult } from "./interfaces/ProxyManager";
import type { HostPortAvailabilityChecker } from "./ios/IOSHostPortAvailabilityChecker";

/** The narrow readiness seam used by ToolExecutionContext. */
export interface DeviceReadinessProxyDriver {
  resetSetupState(): void;
  rebindIfUnhealthy?(): Promise<boolean>;
  setup(force: boolean, perf: PerformanceTracker): Promise<ProxySetupResult>;
  waitForConnection(): Promise<boolean>;
  resetConnectionBudget?(): void;
  isInstalled(): Promise<boolean>;
  isVersionCompatible(): Promise<boolean>;
}

export type DeviceReadinessProxyDriverProvider = (
  device: BootedDevice,
) => DeviceReadinessProxyDriver;

/** Test-only values read lazily by production modules. All imports here are erased types. */
export const testOverrides: {
  hostPortAvailabilityChecker: HostPortAvailabilityChecker | undefined;
  deviceReadinessProxyDriverProvider: DeviceReadinessProxyDriverProvider | null;
  telemetryNoOpDefault: boolean;
} = {
  hostPortAvailabilityChecker: undefined,
  deviceReadinessProxyDriverProvider: null,
  telemetryNoOpDefault: false,
};
