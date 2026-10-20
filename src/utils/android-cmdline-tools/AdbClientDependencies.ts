import type { BackoffPolicy } from "../Backoff";
import type { AndroidTransportRouting } from "../androidSerial";
import {
  defaultDiscoveryObservationSequence,
  type DiscoveryObservationSequence,
} from "../DiscoveryObservationSequence";
import type { HostProcessExecutor, SpawnFn } from "../HostCommandExecutor";
import type { NativeHelperTracker } from "../nativeHelpers/NativeHelperRegistry";
import type { Timer } from "../SystemTimer";
import type { RetryExecutor } from "../retry/RetryExecutor";
import { DefaultSystemDetection, type SystemDetection } from "../system/SystemDetection";
import type { AdbTransportRestartRegistry } from "./AdbTransportRestartRegistry";
import type { EmulatorConsoleBusyRegistry } from "./EmulatorConsoleBusyRegistry";

/** Optional collaborators for {@link AdbClient}; each defaults to the production one. */
export interface AdbClientDependencies {
  spawnFn?: SpawnFn | null;
  retryExecutor?: RetryExecutor;
  timer?: Timer;
  transportBackoff?: BackoffPolicy;
  systemDetectionFactory?: () => SystemDetection;
  /** Monotonic discovery ordering source. */
  observationSequence?: DiscoveryObservationSequence;
  /** Shared console-exclusive operation state. */
  consoleBusyRegistry?: EmulatorConsoleBusyRegistry;
  /** Per-command budget when no timeout is supplied. */
  defaultTimeoutMs?: number;
  /** Host process executor for cancellable commands. */
  hostProcessExecutor?: HostProcessExecutor;
  /** Per-pool alias routing for the target serial. */
  transportRouting?: AndroidTransportRouting;
  /** Marks serials whose adbd this client restarts. */
  transportRestartRegistry?: AdbTransportRestartRegistry;
  nativeHelperRegistry?: NativeHelperTracker;
}

export const DEFAULT_ADB_COMMAND_TIMEOUT_MS = 15_000;

/** The settings every client needs, with production defaults filled in. */
export function resolveAdbClientSettings(dependencies: AdbClientDependencies) {
  return {
    systemDetectionFactory:
      dependencies.systemDetectionFactory ?? (() => new DefaultSystemDetection()),
    observationSequence: dependencies.observationSequence ?? defaultDiscoveryObservationSequence,
    defaultTimeoutMs: dependencies.defaultTimeoutMs ?? DEFAULT_ADB_COMMAND_TIMEOUT_MS,
  };
}
