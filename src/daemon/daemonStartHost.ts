import type { DaemonExitRecord } from "./daemonExitRecord";
import type { RehydrationSummary } from "./sessionManager";
import type { UnixSocketServer } from "./socketServer";
import type {
  DaemonTerminalReleaseJournalOptions,
  TerminalReleaseJournal,
} from "./terminalReleaseJournal";

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
  /** The AVD provenance warm-up, port selection and the HTTP MCP listener. */
  startHttpIngress(): Promise<void>;
  /** Drop per-session appearance rows no rehydrated or recoverable session owns (#10976). */
  sweepStaleAppearanceConfigs(rehydration: RehydrationSummary): Promise<void>;
  /** Mark unconfirmed recorders before sessions can bind; never await background recovery. */
  redriveRecorderTeardowns(): Promise<boolean>;
  /** Create the control socket server over this daemon's state and start accepting clients. */
  bindControlSocket(): Promise<UnixSocketServer>;
  /** Auxiliary sockets, device monitors, the PID file and the health check. */
  startServicesAfterSocketBind(): Promise<void>;
  /** Navigation retention, forwarding-lease idle release, the orphan watchdog and broker reclaim. */
  startMaintenanceMonitors(): void;
}
