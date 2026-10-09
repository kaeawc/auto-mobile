import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";

/** What the watchdog observes about this daemon process. */
export interface PrivateDaemonOrphanPort {
  /** Current parent PID; 1 once the launching parent has exited and init adopted us. */
  parentPid(): number;
  /** Open control-socket and auxiliary-socket connections and in-flight HTTP requests. */
  clientCount(): number;
  /**
   * Monotonic count of client connections and HTTP requests ever accepted, so
   * short-lived clients that come and go between checks still count as use.
   */
  clientActivityCount(): number;
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

/** Explicit harness marker: `1` arms the orphan watchdog, `0` opts a daemon out of it. */
export const HARNESS_PRIVATE_DAEMON_ENV = "AUTOMOBILE_HARNESS_PRIVATE_DAEMON";

/**
 * A harness-style private daemon (a test, lane, or acceptance run) is one whose
 * launcher says so (`AUTOMOBILE_HARNESS_PRIVATE_DAEMON=1`), or, failing an explicit
 * marker, one that both EXPLICITLY overrides its control socket
 * (`AUTOMOBILE_DAEMON_SOCKET_PATH`) to a non-default path and isolates its
 * auxiliary socket directory -- the shape of every ad-hoc private daemon behind
 * #10497. The effective socket path alone is not evidence: since #10881 any
 * `AUTOMOBILE_AUX_SOCKET_DIR` daemon gets a suffixed control socket, so a user's
 * long-lived daemon configured with only an aux dir must not be shut down 15
 * minutes after its launcher exits (#10906). Neither is a user's daemon that
 * merely uses a custom control socket, nor the resident daemon on the default one.
 */
export function isHarnessPrivateDaemon(
  socketPath: string,
  defaultSocketPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const marker = firstNonBlank(env, HARNESS_PRIVATE_DAEMON_ENV);
  if (marker === "1" || marker === "0") {
    return marker === "1";
  }
  const explicitSocket = firstNonBlank(
    env,
    "AUTOMOBILE_DAEMON_SOCKET_PATH",
    "AUTO_MOBILE_DAEMON_SOCKET_PATH",
  );
  return (
    explicitSocket !== "" &&
    socketPath !== defaultSocketPath &&
    firstNonBlank(env, "AUTOMOBILE_AUX_SOCKET_DIR") !== ""
  );
}

function firstNonBlank(env: NodeJS.ProcessEnv, ...keys: string[]): string {
  return keys.map((key) => env[key]?.trim() ?? "").find((value) => value !== "") ?? "";
}

/**
 * Shuts down a private daemon whose launching parent has exited and that has
 * had no clients and no sessions for `idleMs` (issue #10497), so a test daemon
 * cannot hold devices for hours after its test ends.
 */
export class PrivateDaemonOrphanWatchdog {
  private orphanIdleSince: number | null = null;
  private lastClientActivityCount: number | null = null;
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
    const activityCount = this.port.clientActivityCount();
    const clientSinceLastCheck =
      this.lastClientActivityCount !== null && activityCount !== this.lastClientActivityCount;
    this.lastClientActivityCount = activityCount;
    const orphanedAndIdle =
      this.port.parentPid() === INIT_PID &&
      !clientSinceLastCheck &&
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
