import { DeviceClaimMirrorHub } from "./deviceClaimMirrorHub";
import type { DaemonSocketServer } from "./daemonSocketServer";
import type { getDeviceDataStreamServer } from "./deviceDataStreamSocketServer";
import type { DaemonBrokerDeviceAcquisitionHandle } from "./sessionBroker/provisioning/daemonDeviceAcquisition";
import type { ManagedExecutionReowner } from "./sessionBroker/provisioning/executionReowner";
import type { BackgroundBindingRegistryUpgrade } from "./sessionBroker/registry/BackgroundBindingRegistryUpgrade";
import type { SqliteBindingRegistry } from "./sessionBroker/registry/sqliteBindingRegistry";
import type { SessionHeartbeatMonitor } from "./SessionHeartbeatMonitor";
import type { SingleFlightInterval } from "./SingleFlightInterval";
import type { DeviceForwardLeaseIdleReleaser } from "./deviceForwardLeaseIdleReleaser";
import type { PrivateDaemonOrphanWatchdog } from "./privateDaemonOrphanWatchdog";
import type { NavigationRetentionMonitor } from "./NavigationRetentionMonitor";

/**
 * Mutable lifecycle flags and background-monitor handles the daemon sets while starting and
 * clears while stopping. Held in one object so `Daemon` does not carry each as its own field.
 */
export class DaemonRuntimeState {
  /** The device-claim mirrors of this daemon, told when its binding registry opens (#11811). */
  readonly deviceClaimMirrors = new DeviceClaimMirrorHub();
  pidFileWritten = false;
  enteredDaemonProcess = false;
  completeIdentityPublished = false;
  socketBindCommitted = false;
  lastDatabaseHealthFailure: string | undefined;

  healthCheck: SingleFlightInterval | null = null;
  heartbeatMonitor: SessionHeartbeatMonitor | null = null;
  navigationRetentionMonitor: NavigationRetentionMonitor | null = null;
  forwardLeaseIdleReleaser: DeviceForwardLeaseIdleReleaser | null = null;
  orphanWatchdog: PrivateDaemonOrphanWatchdog | null = null;

  socketServer: DaemonSocketServer | null = null;
  deviceDisconnectMonitor: SingleFlightInterval | null = null;
  deferredSessionRecoverySweeps: Set<Promise<void>> = new Set();
  bindingRegistry: Promise<SqliteBindingRegistry> | undefined;
  brokerDeviceAcquisition: DaemonBrokerDeviceAcquisitionHandle | undefined;
  managedExecutionReowner: ManagedExecutionReowner | undefined;
  deviceDataStreamServer: ReturnType<typeof getDeviceDataStreamServer> = null;
  unsubscribeAdbMissingDevice: (() => void) | null = null;
  /** Redrives retained startup recorder descriptors when a device incarnation is assigned. */
  recorderDeviceIncarnationListener: ((deviceId: string) => void) | undefined;
  backgroundRegistryUpgrade: BackgroundBindingRegistryUpgrade | undefined;
}
