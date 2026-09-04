import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

/**
 * Attempts a bare, side-effect-free connection to a daemon socket/pipe and reports
 * whether it is reachable. MUST NOT touch the socket file (no stat-clean, no unlink).
 */
export type DaemonSocketConnectAttempt = (
  socketPath: string,
  timeoutMs: number,
  timer: Timer,
) => Promise<boolean>;

export interface DaemonSocketReachabilityDeps {
  platform?: NodeJS.Platform;
  existsSyncFn?: (path: string) => boolean;
  connectAttempt?: DaemonSocketConnectAttempt;
  timer?: Timer;
}

/**
 * Observation-only reachability check for a daemon control socket/pipe (issue #6103).
 *
 * The post-exit peer rejoin needs to know "is a peer daemon accepting on the shared
 * socket right now?" WITHOUT the destructive recovery behavior of
 * {@link DaemonClient.connect}, which on a failed attempt calls
 * `cleanupStaleSocketIfDaemonDead` and can UNLINK the socket when the PID file records
 * a dead process. During a cross-checkout startup race the live race winner can own
 * the shared socket without owning that PID record, so a single transient refusal
 * there would delete the winner's live endpoint and strand every client. This probe
 * therefore only ever attempts a connection and reports the result — it never cleans
 * up or unlinks anything.
 *
 * It is also platform-aware AT THE CONNECTION LAYER: on POSIX a Unix socket has a
 * filesystem entry, so a missing path means nothing is listening and the connect is
 * skipped (so a missing socket isn't hammered); on Windows the socket is a named pipe
 * with no filesystem entry, so the connect is attempted regardless (mirroring
 * {@link DaemonClient.isAvailable}'s `platform() !== "win32"` branch). Without this a
 * reachable Windows peer — whose pipe `existsSync` always reports absent — would never
 * be probed or joined.
 *
 * All external dependencies (platform, filesystem check, the raw connect, the timer)
 * are injected so the platform branch and the connection outcome are testable without
 * real sockets.
 */
export class DaemonSocketReachability {
  private readonly platform: NodeJS.Platform;
  private readonly existsSyncFn: (path: string) => boolean;
  private readonly connectAttempt: DaemonSocketConnectAttempt;
  private readonly timer: Timer;

  constructor(deps: DaemonSocketReachabilityDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.existsSyncFn = deps.existsSyncFn ?? existsSync;
    this.connectAttempt = deps.connectAttempt ?? rawObservationOnlyConnectAttempt;
    this.timer = deps.timer ?? defaultTimer;
  }

  /**
   * Whether the daemon socket/pipe is currently accepting connections. Returns false
   * (rather than throwing) for every not-reachable case, and never mutates the socket
   * file.
   */
  async isReachable(socketPath: string, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) {
      return false;
    }
    // POSIX: a missing filesystem entry means nothing is listening yet — skip the
    // connect so a nonexistent Unix socket isn't hammered. Windows named pipes have no
    // filesystem entry, so the connect must be attempted regardless.
    if (this.platform !== "win32" && !this.existsSyncFn(socketPath)) {
      return false;
    }
    return this.connectAttempt(socketPath, timeoutMs, this.timer);
  }
}

/**
 * The default connect attempt: a raw {@link createConnection} bounded by `timeoutMs`,
 * reporting reachable on connect and not-reachable on error or timeout. It destroys the
 * probe socket on every exit path and — deliberately, unlike the DaemonClient recovery
 * path — never unlinks or cleans up the socket file.
 */
const rawObservationOnlyConnectAttempt: DaemonSocketConnectAttempt = (
  socketPath,
  timeoutMs,
  timer,
) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      timer.clearTimeout(timeout);
      socket.destroy();
      resolve(value);
    };

    const socket = createConnection(socketPath, () => settle(true));
    // No cleanupStaleSocketIfDaemonDead on error: this probe must never delete a live
    // peer's endpoint (issue #6103).
    socket.on("error", () => settle(false));
    const timeout = timer.setTimeout(() => settle(false), timeoutMs);
  });
