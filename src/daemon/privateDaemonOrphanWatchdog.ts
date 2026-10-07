import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";

/** What the watchdog observes about this daemon process. */
export interface PrivateDaemonOrphanPort {
  /** Current parent PID; 1 once the launching parent has exited and init adopted us. */
  parentPid(): number;
  /** Connected socket and HTTP MCP clients. */
  clientCount(): number;
  /** Live device sessions. */
  liveSessionCount(): number;
  /** Begin graceful shutdown. */
  shutdown(reason: string): void;
}

export const DEFAULT_PRIVATE_DAEMON_ORPHAN_IDLE_MS = 15 * 60_000;
export const PRIVATE_DAEMON_ORPHAN_IDLE_MS_ENV = "AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS";
const CHECK_INTERVAL_MS = 30_000;
const INIT_PID = 1;

/** Idle timeout for an orphaned private daemon; 0 disables the watchdog. */
export function resolvePrivateDaemonOrphanIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PRIVATE_DAEMON_ORPHAN_IDLE_MS_ENV];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PRIVATE_DAEMON_ORPHAN_IDLE_MS;
}

/**
 * A private daemon runs on a non-default socket (a test, lane, or harness). The
 * user's resident daemon on the default socket is never subject to the watchdog.
 */
export function isPrivateDaemonSocket(socketPath: string, defaultSocketPath: string): boolean {
  return socketPath !== defaultSocketPath;
}

/**
 * Shuts down a private daemon whose launching parent has exited and that has
 * had no clients and no sessions for `idleMs` (issue #10497), so a test daemon
 * cannot hold devices for hours after its test ends.
 */
export class PrivateDaemonOrphanWatchdog {
  private orphanIdleSince: number | null = null;
  private handle: NodeJS.Timeout | null = null;
  private shutdownRequested = false;

  constructor(
    private readonly port: PrivateDaemonOrphanPort,
    private readonly idleMs: number,
    private readonly timer: Timer = defaultTimer,
    private readonly checkIntervalMs: number = Math.min(CHECK_INTERVAL_MS, idleMs),
  ) {}

  start(): void {
    if (this.handle || this.idleMs <= 0) {
      return;
    }
    this.handle = this.timer.setInterval(() => this.check(), this.checkIntervalMs);
    const handle = this.handle as { unref?: () => void };
    if (typeof handle.unref === "function") {
      handle.unref();
    }
  }

  stop(): void {
    if (this.handle) {
      this.timer.clearInterval(this.handle);
      this.handle = null;
    }
  }

  /** One check; returns true when it requested shutdown. */
  check(): boolean {
    if (this.shutdownRequested) {
      return false;
    }
    const orphanedAndIdle =
      this.port.parentPid() === INIT_PID &&
      this.port.clientCount() === 0 &&
      this.port.liveSessionCount() === 0;
    const now = this.timer.now();
    if (!orphanedAndIdle) {
      this.orphanIdleSince = null;
      return false;
    }
    this.orphanIdleSince ??= now;
    if (now - this.orphanIdleSince < this.idleMs) {
      return false;
    }
    this.shutdownRequested = true;
    this.stop();
    const reason =
      `private daemon's parent exited and it has had no clients or sessions for ` +
      `${Math.round((now - this.orphanIdleSince) / 1000)}s`;
    logger.warn(`[Daemon] Shutting down orphaned private daemon: ${reason}`);
    this.port.shutdown(reason);
    return true;
  }
}
