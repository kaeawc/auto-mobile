import { ActionableError } from "../models";
import { DaemonState } from "./daemonState";
import { resolveCapabilityBaseSessionUuid } from "../features/toolCapabilities/capabilitySessionResolver";

/**
 * Authentication + session-scoping for the two live-screen daemon sockets
 * (`webrtc-stream.sock`, `video-stream.sock`).
 *
 * These sockets historically accepted `start`/`subscribe` from any local process
 * with no identity check, so any process running as the user could publish the
 * device screen to an attacker-controlled WHIP server or silently subscribe to
 * the raw H.264 stream (issue #4751). This module extends the SAME session
 * identity mechanism the main daemon socket uses (issue #4655): a request must
 * carry a `sessionUuid` that resolves to a live daemon session, and it may only
 * target a device that is unowned or owned by that same session — a subscriber
 * cannot ride along on another session's capture.
 *
 * Enforcement is on by default; `AUTOMOBILE_DAEMON_STREAM_AUTH=0` disables it,
 * mirroring the daemon handshake's `AUTOMOBILE_DAEMON_HANDSHAKE`-style opt-out
 * for setups whose clients cannot yet supply a session UUID.
 */

/** Env flag that opts a daemon out of stream-socket authentication. */
export const STREAM_SOCKET_AUTH_ENV = "AUTOMOBILE_DAEMON_STREAM_AUTH";

/**
 * The narrow SessionManager surface the authenticator needs. Kept minimal
 * (YAGNI) and structurally satisfied by the real `SessionManager`, so the same
 * live registry that #4655 tracks backs the check.
 */
export interface StreamAuthSessionManager {
  getSession(sessionUuid: string): unknown | null;
  getSessionForDevice(deviceId: string): string | null;
  getDeviceLabels(sessionUuid: string): Record<string, string> | undefined;
}

export interface StreamAuthorizeInput {
  /** Session UUID declared on the wire; the caller's proof of daemon admission. */
  sessionUuid?: string;
  /** Target device, when the request names one. */
  deviceId?: string;
}

export interface StreamSocketAuthenticator {
  /**
   * Authorize a stream control request. Throws {@link ActionableError} when the
   * request is unauthenticated, names an unknown/expired session, or targets a
   * device bound to a different session.
   */
  authorize(input: StreamAuthorizeInput): void;
}

function authEnforced(env: NodeJS.ProcessEnv): boolean {
  const raw = (env[STREAM_SOCKET_AUTH_ENV] ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/**
 * Authenticates against the daemon's live session registry. A request must
 * carry a `sessionUuid` resolving to an active session; when it also names a
 * device, that device must be unowned or owned by the same base session.
 */
export class SessionScopedStreamAuthenticator implements StreamSocketAuthenticator {
  constructor(
    private readonly resolveSessionManager: () => StreamAuthSessionManager | null,
    private readonly operation: string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  authorize({ sessionUuid, deviceId }: StreamAuthorizeInput): void {
    if (!authEnforced(this.env)) {
      return;
    }

    const uuid = typeof sessionUuid === "string" ? sessionUuid.trim() : "";
    if (!uuid) {
      throw new ActionableError(
        `${this.operation} requires an authenticated daemon session. Connect through the AutoMobile ` +
          `daemon and include its sessionUuid on the request; set ${STREAM_SOCKET_AUTH_ENV}=0 to disable ` +
          `this check (not recommended).`
      );
    }

    const sessionManager = this.resolveSessionManager();
    if (!sessionManager) {
      throw new ActionableError(
        `${this.operation} cannot be authenticated: the daemon session registry is unavailable. ` +
          `Ensure the request is made against a running AutoMobile daemon.`
      );
    }

    // Resolve derived `${base}:${label}` device-label sessions to the base whose
    // identity the daemon tracks, exactly as the main socket does (#4611/#4655).
    const baseSessionUuid = resolveCapabilityBaseSessionUuid(uuid, sessionManager) ?? uuid;
    if (!sessionManager.getSession(baseSessionUuid)) {
      throw new ActionableError(
        `${this.operation} rejected: session ${uuid} is not an active daemon session (unknown or expired).`
      );
    }

    if (deviceId) {
      this.assertDeviceScope(sessionManager, deviceId, baseSessionUuid);
    }
  }

  /**
   * A subscriber may only target a device that is unowned or owned by its own
   * base session — it cannot ride along on another session's capture.
   */
  private assertDeviceScope(
    sessionManager: StreamAuthSessionManager,
    deviceId: string,
    baseSessionUuid: string
  ): void {
    const owner = sessionManager.getSessionForDevice(deviceId) ?? undefined;
    if (!owner) {
      return;
    }
    const ownerBase = resolveCapabilityBaseSessionUuid(owner, sessionManager) ?? owner;
    if (ownerBase !== baseSessionUuid) {
      throw new ActionableError(
        `${this.operation} rejected: device ${deviceId} is bound to a different daemon session; ` +
          `a subscriber cannot attach to another session's capture without authorization.`
      );
    }
  }
}

/**
 * The production authenticator, wired to the daemon's singleton session
 * registry. Fails closed: when the daemon is not initialized the registry is
 * unavailable and every request is rejected.
 */
export function createDefaultStreamSocketAuthenticator(operation: string): StreamSocketAuthenticator {
  return new SessionScopedStreamAuthenticator(() => {
    const state = DaemonState.getInstance();
    return state.isInitialized() ? state.getSessionManager() : null;
  }, operation);
}
