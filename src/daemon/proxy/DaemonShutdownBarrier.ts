import type { DaemonManagerLike } from "../manager";
import {
  DAEMON_RESTART_HANDOFF_TIMEOUT_MS,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
  DAEMON_STARTUP_TIMEOUT_MS,
} from "../wire/constants";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";

/**
 * What the shutdown barrier needs from its proxy:
 * - hasClient / clientReportsPeerClose describe the attached daemon connection.
 * - markQuiesced stops ensureConnected() from reusing the draining incarnation.
 * - resetConnection detaches and closes the attached client.
 */
export interface DaemonShutdownBarrierPort {
  hasClient(): boolean;
  clientReportsPeerClose(): boolean;
  markQuiesced(): void;
  resetConnection(): Promise<void>;
  isClosing(): boolean;
  socketPath(): string;
  autoStartDaemon(): boolean;
}

export interface DaemonShutdownBarrierDeps {
  timer: Timer;
  daemonManager: Pick<DaemonManagerLike, "status" | "isStartupLockHeldByLiveProcess">;
  daemonAvailabilityProbe: (socketPath: string) => Promise<boolean>;
}

/**
 * Peer-close barrier armed by a `daemon-shutdown` release or an EOF on the attached client.
 * Calls admitted for replacement acquisition wait on {@link pending} instead of reconnecting to
 * the still-reachable but quiesced incarnation, then through the bounded restart window.
 */
export class DaemonShutdownBarrier {
  private disconnect: Promise<void> | null = null;
  private resolveDisconnect: (() => void) | null = null;

  constructor(
    private readonly port: DaemonShutdownBarrierPort,
    private readonly deps: DaemonShutdownBarrierDeps,
  ) {}

  /** The armed barrier, or null. Return it as-is: callers rely on awaiting this exact promise. */
  get pending(): Promise<void> | null {
    return this.disconnect;
  }

  /** The resolver of the currently armed barrier, captured by callers that complete it later. */
  get currentResolver(): (() => void) | null {
    return this.resolveDisconnect;
  }

  arm(): void {
    if (this.disconnect || !this.port.hasClient()) {
      return;
    }
    const disconnect = Promise.withResolvers<void>();
    let peerDisconnected = false;
    const completeDisconnect = (): void => {
      peerDisconnected = true;
      disconnect.resolve();
    };
    const timeoutHandle = this.deps.timer.setTimeout(
      disconnect.resolve,
      DAEMON_SHUTDOWN_TIMEOUT_MS,
    );
    const barrier = disconnect.promise
      .then(async () => {
        this.deps.timer.clearTimeout(timeoutHandle);
        if (!peerDisconnected) {
          if (this.resolveDisconnect === completeDisconnect) {
            this.resolveDisconnect = null;
          }
          // A stalled transport must not remain attached after the bounded EOF
          // wait. resetConnection detaches it synchronously before closing it.
          void this.port.resetConnection();
        }
        await this.waitForRestartWindow();
      })
      .catch((error) => {
        // Readiness is re-checked by doConnect; this barrier only prevents the
        // deterministic stale-PID/no-startup-lock gap from racing that path.
        logger.warn(`[DaemonMcpProxy] Failed while awaiting daemon restart transition: ${error}`);
      });
    this.disconnect = barrier;
    this.resolveDisconnect = completeDisconnect;
    void barrier.then(() => {
      if (this.disconnect === barrier) {
        this.disconnect = null;
      }
    });
    // Keep the old client attached long enough to observe peer EOF, but prevent
    // ensureConnected() from treating this quiesced incarnation as reusable.
    this.port.markQuiesced();
    if (!this.port.clientReportsPeerClose()) {
      // This client cannot report peer EOF. Begin detaching now; the timeout
      // still bounds a custom close() implementation that never settles.
      void this.port.resetConnection();
    }
  }

  complete(expectedResolve: (() => void) | null = this.resolveDisconnect): void {
    if (this.resolveDisconnect !== expectedResolve) {
      return;
    }
    this.resolveDisconnect = null;
    expectedResolve?.();
  }

  private async waitForRestartWindow(): Promise<void> {
    const { timer, daemonManager, daemonAvailabilityProbe } = this.deps;
    const socketPath = this.port.socketPath();
    let deadline =
      timer.now() + Math.max(DAEMON_STARTUP_TIMEOUT_MS, DAEMON_RESTART_HANDOFF_TIMEOUT_MS);
    let emptyHandoffDeadline: number | undefined;
    while (!this.port.isClosing() && timer.now() < deadline) {
      if (await daemonAvailabilityProbe(socketPath)) {
        return;
      }
      const status = await daemonManager.status();
      const startupLockHeld = daemonManager.isStartupLockHeldByLiveProcess();
      if (startupLockHeld && this.port.autoStartDaemon()) {
        // doConnect() may now join the lock holder through DaemonManager.start().
        return;
      }
      if (startupLockHeld || status.running) {
        // A successor has begun publishing ownership. Clients with auto-start
        // disabled cannot join its lock, so keep their barrier active until its
        // socket becomes reachable under the overall startup deadline.
        emptyHandoffDeadline = undefined;
      } else {
        // Explicit restart deliberately leaves no PID and no startup lock while
        // it pauses between stop and start. Preserve that handoff instead of
        // racing to start a daemon with this proxy's potentially different
        // options.
        emptyHandoffDeadline ??= timer.now() + DAEMON_RESTART_HANDOFF_TIMEOUT_MS;
        // A short startup-timeout override must not truncate the complete
        // bounded restart preflight after the empty handoff is first observed.
        deadline = Math.max(deadline, emptyHandoffDeadline);
        if (timer.now() >= emptyHandoffDeadline) {
          return;
        }
      }
      const waitDeadline = emptyHandoffDeadline ?? deadline;
      await timer.sleep(Math.min(100, waitDeadline - timer.now()));
    }
  }
}
