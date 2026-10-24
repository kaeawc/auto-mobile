import type { HostLoadReader } from "./hostLoadBudget";
import type { BootedDevice } from "../models";
import type { GitMetadataClient } from "./GitMetadataClient";
import type { PerformanceTracker } from "./PerformanceTracker";
import type { ProxySetupResult } from "./interfaces/ProxyManager";
import type { PortAvailabilityChecker } from "./PortManager";

/** The narrow readiness seam used by ToolExecutionContext. */
export interface DeviceReadinessProxyDriver {
  resetSetupState(): void;
  rebindIfUnhealthy?(): Promise<boolean>;
  verifyServiceReady?(): Promise<boolean>;
  forceRestartProcess?(): Promise<boolean>;
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
  /** Host load seam so load-scaled budgets never depend on the machine running the tests. */
  hostLoad: HostLoadReader | undefined;
  /** In-process version metadata seam; never inherited by spawned children. */
  gitMetadataClient: GitMetadataClient | undefined;
  hostPortAvailabilityChecker: PortAvailabilityChecker | undefined;
  deviceReadinessProxyDriverProvider: DeviceReadinessProxyDriverProvider | null;
  telemetryNoOpDefault: boolean;
  /** Directory read by auxiliary socket configs during in-process tests. */
  auxSocketDir: string | undefined;
  /** Keeps the shared boot admission gates from sampling the real host (adb, ps, simctl). */
  bootAdmissionGatesDisabled: boolean;
  /** True while the daemon must not read its own process generation token (`ps` on macOS). */
  processGenerationCaptureDisabled: (() => boolean) | undefined;
  /** True while in-process log records are discarded before formatting instead of reaching the file, stderr or stdout sinks. */
  logSinksDisabled: (() => boolean) | undefined;
} = {
  hostLoad: undefined,
  gitMetadataClient: undefined,
  hostPortAvailabilityChecker: undefined,
  deviceReadinessProxyDriverProvider: null,
  telemetryNoOpDefault: false,
  auxSocketDir: undefined,
  bootAdmissionGatesDisabled: false,
  processGenerationCaptureDisabled: undefined,
  logSinksDisabled: undefined,
};
