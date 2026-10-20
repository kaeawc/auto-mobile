import {
  initializeRecordingTeardownRedriveState,
  listActiveVideoRecordings,
  setStartupOrphanCaptures,
  setVideoRecordingManagerDependencies,
} from "./videoRecordingManager";
import { redriveUnconfirmedCaptureTeardowns } from "./recordingTeardownRedrive";
import type { DaemonExitRecord } from "./daemonExitRecord";
import type { DaemonSocketServer } from "./daemonSocketServer";
import type { RehydrationSummary } from "./sessionManager";
import type {
  DaemonTerminalReleaseJournalOptions,
  TerminalReleaseJournal,
} from "./terminalReleaseJournal";

/** Server recording operations supplied by the daemon composition root. */
export interface DaemonRecordingHost {
  initializeRecordingTeardownRedriveState: typeof initializeRecordingTeardownRedriveState;
  listActiveVideoRecordings: typeof listActiveVideoRecordings;
  redriveUnconfirmedCaptureTeardowns: typeof redriveUnconfirmedCaptureTeardowns;
  setStartupOrphanCaptures: typeof setStartupOrphanCaptures;
  setVideoRecordingManagerDependencies: typeof setVideoRecordingManagerDependencies;
}

/**
 * The steps of `Daemon.start()` that touch the machine: the process's working directory and
 * signal handlers, the PID file, the data directory, listening sockets, and the monitors that
 * probe devices. `start()` runs the process's own; `Daemon.startOn()` runs a caller's, so a test
 * harness starts a daemon through the same sequence with nothing reaching the host (#11441).
 * Each step sits where `start()` has always run it.
 */
export interface DaemonStartHost {
  /** Synchronous self-exit policy record; fake hosts keep it in memory. */
  writeExitRecord(record: DaemonExitRecord): void;
  /** Logging, the stable working directory and the shutdown handlers. */
  enterProcess(): void;
  /** Name this daemon's control socket in the CtrlProxy forwarding leases it takes (#10497). */
  publishForwardLeaseOwner(): void;
  /** Publish the owned database path in the PID file before the database opens (#2871). */
  writeEarlyOwnerRecord(): Promise<void>;
  /** This daemon's terminal-release journal, with dead daemons' intents adopted (#10959). */
  openTerminalReleaseJournal(
    owner: Pick<DaemonTerminalReleaseJournalOptions, "daemonSessionId" | "liveDaemonSessionIds">,
  ): TerminalReleaseJournal;
  /** Require this daemon's in-memory HTTP credential before binding the listener. */
  prepareHttpToken(): void;
  /** Publish this daemon's HTTP credential only after the listener has bound. */
  publishHttpToken(): void;
  /** The AVD provenance warm-up, port selection and the HTTP MCP listener. */
  startHttpIngress(): Promise<void>;
  /** Drop per-session appearance rows no rehydrated or recoverable session owns (#10976). */
  sweepStaleAppearanceConfigs(rehydration: RehydrationSummary): Promise<void>;
  /** Mark unconfirmed recorders before sessions can bind; never await background recovery. */
  redriveRecorderTeardowns(): Promise<boolean>;
  /** Create the control socket server over this daemon's state and start accepting clients. */
  bindControlSocket(): Promise<DaemonSocketServer>;
  /** Auxiliary sockets, device monitors, the PID file and the health check. */
  startServicesAfterSocketBind(): Promise<void>;
  /** Navigation retention, forwarding-lease idle release, the orphan watchdog and broker reclaim. */
  startMaintenanceMonitors(): void;
}

/** Production recording ports kept together at the daemon-to-server composition boundary. */
export const defaultDaemonRecordingHost: DaemonRecordingHost = {
  initializeRecordingTeardownRedriveState: (...args) =>
    initializeRecordingTeardownRedriveState(...args),
  listActiveVideoRecordings: (...args) => listActiveVideoRecordings(...args),
  redriveUnconfirmedCaptureTeardowns: (...args) => redriveUnconfirmedCaptureTeardowns(...args),
  setStartupOrphanCaptures: (...args) => setStartupOrphanCaptures(...args),
  setVideoRecordingManagerDependencies: (...args) => setVideoRecordingManagerDependencies(...args),
};
