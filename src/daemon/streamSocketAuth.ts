import type { StreamSubscriptionIdentity } from "./streamSubscriptionPolicy";
import type { ObserverSessionStore } from "./observerSessionRegistry";
import { isSessionReleasing } from "./sessionReleaseState";
import { ActionableError } from "../models";
import { DaemonState } from "./daemonState";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";

/**
 * Authentication + session-scoping for the two live-screen daemon sockets
 * (`webrtc-stream.sock`, `video-stream.sock`).
 *
 * These sockets historically accepted `start`/`subscribe` from any local process
 * with no identity check, so any process running as the user could publish the
 * device screen to an attacker-controlled WHIP server or silently subscribe to
 * the raw H.264 stream (issue #4751). This module extends the SAME session
 * identity mechanism the main daemon socket uses (issue #4655): a request must
 * carry a `sessionUuid` resolving to a live, non-releasing device session (or,
 * on authenticators built with `allowObserverSessions`, a live registered
 * observer). Video relay subscribe, WebRTC start and the observation socket's
 * on-demand reads (#10830) explicitly admit read-only viewers on any device; the
 * owning session attaches with owner kind. The viewer
 * grant (#10698) is held by any live identity, device session or observer alike,
 * so a desktop that holds nothing can watch a device an agent drives, and holding
 * an unrelated device grants nothing more. Viewers cannot mutate an owner's
 * capture or control (and `input/*` refuses a non-holder, see
 * inputDeviceOwnership.ts). Other callers retain strict device scope.
 * See streamSubscriptionPolicy.ts for the shared subscription lifecycle rule.
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
  getReleasingSession?(sessionUuid: string): unknown | null;
  getSessionForDevice(deviceId: string): string | null;
  getDeviceLabels(sessionUuid: string): Record<string, string> | undefined;
}

export interface StreamAuthorizeInput {
  /** Session UUID declared on the wire; the caller's proof of daemon admission. */
  sessionUuid?: string;
  /** Target device, when the request names one. */
  deviceId?: string;
  /** Read-only admission (video relay, WebRTC, observation reads): a live non-owner may watch. */
  admitViewer?: boolean;
  /** Rechecks of an attached subscriber require its session to still own the device. */
  requireOwnership?: boolean;
}

export interface StreamSocketAuthenticator {
  /**
   * Authorize a stream control request. Throws {@link ActionableError} when the
   * request is unauthenticated, names an unknown/expired session, or targets a
   * device bound to a different session unless read-only viewer admission is enabled.
   */
  authorize(input: StreamAuthorizeInput): void;
  /** Structured live identity/ownership query; does not alter admission authorization. */
  resolveSubscriptionIdentity?(input: StreamAuthorizeInput): StreamSubscriptionIdentity;
  /** Canonical base identity for lease ownership, when available. */
  resolveSessionIdentity?(sessionUuid?: string): string | undefined;
  /** Whether caller identity is verified; absent implementations default to enforced. */
  isAuthenticationEnforced?(): boolean;
}

/** Check the device selected by discovery before starting device-side work. */
export function authorizeResolvedDevice(
  authenticator: StreamSocketAuthenticator,
  options: StreamAuthorizeInput & { deviceId: string },
): void {
  authenticator.authorize(options);
}

function authEnforced(env: NodeJS.ProcessEnv): boolean {
  const raw = (env[STREAM_SOCKET_AUTH_ENV] ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/**
 * Authenticates against the daemon's live session registry. A request must
 * carry a `sessionUuid` resolving to an active session; when it also names a
 * device, strict scope requires it to be unowned or owned by the same base session.
 * Only explicit viewer admission relaxes scope; requireOwnership always stays strict.
 */
export class SessionScopedStreamAuthenticator implements StreamSocketAuthenticator {
  constructor(
    private readonly resolveSessionManager: () => StreamAuthSessionManager | null,
    private readonly operation: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  isAuthenticationEnforced(): boolean {
    return authEnforced(this.env);
  }

  resolveSessionIdentity(sessionUuid?: string): string | undefined {
    const uuid = typeof sessionUuid === "string" ? sessionUuid.trim() : "";
    if (!uuid) {
      return undefined;
    }
    if (!this.isAuthenticationEnforced()) {
      return uuid;
    }
    const sessionManager = this.resolveSessionManager();
    return sessionManager
      ? (resolveToolSelectionBaseSessionUuid(uuid, sessionManager) ?? uuid)
      : uuid;
  }

  resolveSubscriptionIdentity({
    sessionUuid,
    deviceId,
  }: StreamAuthorizeInput): StreamSubscriptionIdentity {
    if (!authEnforced(this.env)) {
      return { authEnabled: false, sessionExists: false, ownsDevice: false };
    }
    const uuid = typeof sessionUuid === "string" ? sessionUuid.trim() : "";
    const manager = this.resolveSessionManager();
    if (!uuid || !manager) {
      return { authEnabled: true, sessionExists: false, ownsDevice: false };
    }
    const base = resolveToolSelectionBaseSessionUuid(uuid, manager) ?? uuid;
    const session = manager.getSession(base);
    // A live observer keeps a viewer subscription alive like a device session does (#10698).
    const sessionExists = session
      ? !isSessionReleasing(manager, base, session)
      : this.admitObserver(base, manager);
    const owner = deviceId ? manager.getSessionForDevice(deviceId) : null;
    return {
      authEnabled: true,
      sessionExists,
      ownsDevice:
        sessionExists &&
        !!owner &&
        (resolveToolSelectionBaseSessionUuid(owner, manager) ?? owner) === base,
      hasDeviceOwner: !!owner,
    };
  }

  authorize({ sessionUuid, deviceId, requireOwnership, admitViewer }: StreamAuthorizeInput): void {
    if (!this.isAuthenticationEnforced()) {
      // Auth-off subscribers may have no session, so ownership changes cannot revoke them.
      return;
    }

    const uuid = typeof sessionUuid === "string" ? sessionUuid.trim() : "";
    if (!uuid) {
      throw new ActionableError(
        `${this.operation} requires an authenticated daemon session. Connect through the AutoMobile ` +
          `daemon and include its sessionUuid on the request; set ${STREAM_SOCKET_AUTH_ENV}=0 to disable ` +
          `this check (not recommended).` +
          this.registrationGuidance,
      );
    }

    const sessionManager = this.resolveSessionManager();
    if (!sessionManager) {
      throw new ActionableError(
        `${this.operation} cannot be authenticated: the daemon session registry is unavailable. ` +
          `Ensure the request is made against a running AutoMobile daemon.`,
      );
    }

    // Resolve derived `${base}:${label}` device-label sessions to the base whose
    // identity the daemon tracks, exactly as the main socket does (#4611/#4655).
    const baseSessionUuid = this.resolveSessionIdentity(uuid) ?? uuid;
    const session = sessionManager.getSession(baseSessionUuid);
    if (!session && !this.admitObserver(baseSessionUuid, sessionManager)) {
      throw new ActionableError(
        `${this.operation} rejected: session ${uuid} is not an active daemon session (unknown or expired).` +
          this.registrationGuidance,
      );
    }
    if (isSessionReleasing(sessionManager, baseSessionUuid, session)) {
      throw new ActionableError(
        `${this.operation} rejected: session ${uuid} is not an active daemon session (being released).` +
          this.registrationGuidance,
      );
    }

    if (deviceId) {
      this.assertDeviceScope({
        sessionManager,
        deviceId,
        baseSessionUuid,
        requireOwnership,
        // The read-only viewer grant: any live identity admitted above (a device session or, on
        // observer-admitting authenticators, a registered observer), whatever it holds (#10698).
        admitViewer,
      });
    }
  }

  protected get registrationGuidance(): string {
    return "";
  }

  protected admitObserver(_sessionUuid: string, _manager: StreamAuthSessionManager): boolean {
    return false;
  }

  /**
   * Viewer admission relaxes scope only for verified device sessions. Explicit
   * ownership checks remain strict, including after a viewer was admitted.
   */
  private assertDeviceScope({
    sessionManager,
    deviceId,
    baseSessionUuid,
    requireOwnership = false,
    admitViewer = false,
  }: {
    sessionManager: StreamAuthSessionManager;
    deviceId: string;
    baseSessionUuid: string;
    requireOwnership?: boolean;
    admitViewer?: boolean;
  }): void {
    if (admitViewer && !requireOwnership) {
      return;
    }
    const owner = sessionManager.getSessionForDevice(deviceId) ?? undefined;
    if (!owner) {
      if (requireOwnership) {
        throw new ActionableError(
          `${this.operation} rejected: device ${deviceId} is no longer owned by session ${baseSessionUuid}.`,
        );
      }
      return;
    }
    const ownerBase = resolveToolSelectionBaseSessionUuid(owner, sessionManager) ?? owner;
    if (ownerBase !== baseSessionUuid) {
      throw new ActionableError(
        `${this.operation} rejected: device ${deviceId} is bound to a different daemon session; ` +
          `a subscriber cannot attach to another session's capture without authorization.`,
      );
    }
  }
}

export interface ObserverStreamAuthenticatorOptions {
  resolveSessionManager: () => StreamAuthSessionManager | null;
  operation: string;
  env?: NodeJS.ProcessEnv;
  resolveObserverRegistry: () => Pick<ObserverSessionStore, "resolveObserverScope"> | null;
}

/**
 * Opt-in admission of registration-only observer sessions. Device scope is unchanged: an observer
 * reaches an owned device only through explicit read-only viewer admission (video relay subscribe,
 * WebRTC start, and the observation socket's on-demand reads, #10830).
 */
export class ObserverAdmittingStreamAuthenticator extends SessionScopedStreamAuthenticator {
  constructor(private readonly options: ObserverStreamAuthenticatorOptions) {
    super(options.resolveSessionManager, options.operation, options.env);
  }

  protected override get registrationGuidance(): string {
    return ` Register a session with daemon/registerSession (or acquire a device session) and include its sessionUuid; set ${STREAM_SOCKET_AUTH_ENV}=0 to disable this check (not recommended).`;
  }

  protected override admitObserver(
    sessionUuid: string,
    manager: StreamAuthSessionManager,
  ): boolean {
    // A releasing device session cannot fall back to a stale observer registration.
    return (
      !manager.getReleasingSession?.(sessionUuid) &&
      (this.options.resolveObserverRegistry()?.resolveObserverScope(sessionUuid).kind ??
        "denied") !== "denied"
    );
  }
}

/**
 * The production authenticator, wired to the daemon's singleton session
 * registry. Fails closed: when the daemon is not initialized the registry is
 * unavailable and every request is rejected.
 */
export function createDefaultStreamSocketAuthenticator(
  operation: string,
  options: { allowObserverSessions?: boolean } = {},
): StreamSocketAuthenticator {
  const resolveSessionManager = () => {
    const state = DaemonState.getInstance();
    return state.isInitialized() ? state.getSessionManager() : null;
  };
  if (options.allowObserverSessions) {
    return new ObserverAdmittingStreamAuthenticator({
      resolveSessionManager,
      operation,
      resolveObserverRegistry: () => {
        const state = DaemonState.getInstance();
        return state.isInitialized() ? (state.getObserverSessionRegistry() ?? null) : null;
      },
    });
  }
  return new SessionScopedStreamAuthenticator(resolveSessionManager, operation);
}
