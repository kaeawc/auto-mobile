import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";

const ABSENT_CONFIRM_DELAY_MS = 50;

export type SocketReachability = "answered" | "absent" | "unknown";

// Every code outside these sets (EACCES, EPERM, EMFILE, ENFILE, EAGAIN, EBUSY,
// ECONNRESET, EPIPE, ETIMEDOUT, ENOTSOCK, ENOMEM, undefined, ...) is unknown by design.
const ABSENT_CONNECT_ERRORS: Record<"posix" | "win32", ReadonlySet<string>> = {
  posix: new Set([
    "ECONNREFUSED", // No listener accepts this Unix socket endpoint.
    "ENOENT", // Missing Unix socket path.
  ]),
  win32: new Set([
    "ENOENT", // Missing Windows named pipe.
    "ECONNREFUSED", // No listener accepts this Windows endpoint.
  ]),
};

/** Only explicit absence errnos authorize reclaim, on POSIX and Windows alike. */
export function classifySocketConnectError(
  code: string | undefined,
  platform: NodeJS.Platform,
): "absent" | "unknown" {
  const absentErrors = ABSENT_CONNECT_ERRORS[platform === "win32" ? "win32" : "posix"];
  return code !== undefined && absentErrors.has(code) ? "absent" : "unknown";
}

/**
 * Attempts a bare, side-effect-free connection to a daemon socket/pipe and reports
 * whether it is reachable. MUST NOT touch the socket file (no stat-clean, no unlink).
 */
export type DaemonSocketConnectAttempt = (
  socketPath: string,
  timeoutMs: number,
  timer: Timer,
  platform: NodeJS.Platform,
) => Promise<SocketReachability>;

export interface DaemonSocketReachabilityDeps {
  platform?: NodeJS.Platform;
  existsSyncFn?: (path: string) => boolean;
  connectAttempt?: DaemonSocketConnectAttempt;
  timer?: Timer;
}

/**
 * The narrow contract the daemon manager's post-exit rejoin depends on: report
 * whether the socket/pipe is reachable, observation-only. Injecting this (rather than
 * subclassing the manager) lets a test drive the probe outcome under a FakeTimer
 * without a real socket, and keeps the real probe wired to the manager's injected timer.
 */
export interface DaemonSocketReachabilityLike {
  probe(socketPath: string, timeoutMs: number): Promise<SocketReachability>;
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
    this.connectAttempt = deps.connectAttempt ?? createObservationOnlyConnectAttempt();
    this.timer = deps.timer ?? defaultTimer;
  }

  /**
   * Distinguishes an answering peer from definite absence and inconclusive probes.
   * Never mutates the socket file; only definite absence can authorize reclaim.
   */
  async probe(socketPath: string, timeoutMs: number): Promise<SocketReachability> {
    if (timeoutMs <= 0) {
      return "unknown";
    }
    // POSIX: a missing filesystem entry means nothing is listening yet — skip the
    // connect so a nonexistent Unix socket isn't hammered. Windows named pipes have no
    // filesystem entry, so the connect must be attempted regardless.
    if (this.platform !== "win32" && !this.existsSyncFn(socketPath)) {
      return "absent";
    }
    const first = await this.connectAttempt(socketPath, timeoutMs, this.timer, this.platform);
    if (first !== "absent" || this.platform === "win32") {
      return first;
    }
    // Darwin can report ECONNREFUSED for a live listener whose backlog is full.
    // Confirm absence after a short pause before authorizing POSIX path reclaim.
    await this.timer.sleep(ABSENT_CONFIRM_DELAY_MS);
    return this.connectAttempt(socketPath, timeoutMs, this.timer, this.platform);
  }
}

/**
 * The default connect attempt: a raw {@link createConnection} bounded by `timeoutMs`,
 * reporting answered on connect, classified errors, and unknown on timeout. It destroys the
 * probe socket on every exit path and — deliberately, unlike the DaemonClient recovery
 * path — never unlinks or cleans up the socket file.
 */
export function createObservationOnlyConnectAttempt(
  connect: typeof createConnection = createConnection,
): DaemonSocketConnectAttempt {
  return (socketPath, timeoutMs, timer, platform) =>
    new Promise<SocketReachability>((resolve) => {
      let settled = false;
      const settle = (value: SocketReachability) => {
        if (settled) {
          return;
        }
        settled = true;
        timer.clearTimeout(timeout);
        socket.destroy();
        resolve(value);
      };

      const socket = connect(socketPath, () => settle("answered"));
      // No cleanupStaleSocketIfDaemonDead on error: this probe must never delete a live
      // peer's endpoint (issue #6103).
      socket.on("error", (error: NodeJS.ErrnoException) =>
        settle(classifySocketConnectError(error.code, platform)),
      );
      const timeout = timer.setTimeout(() => settle("unknown"), timeoutMs);
    });
}
