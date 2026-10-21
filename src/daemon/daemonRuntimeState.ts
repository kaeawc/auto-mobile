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
}
