import {
  SessionScopedStreamAuthenticator,
  STREAM_SOCKET_AUTH_ENV,
  type StreamAuthSessionManager,
  type StreamSocketAuthenticator,
} from "./streamSocketAuth";
import type { ObserverSessionStore } from "./observerSessionRegistry";
import { DaemonState } from "./daemonState";

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

export interface ObserverStreamAuthenticatorOptions {
  resolveSessionManager: () => StreamAuthSessionManager | null;
  operation: string;
  env?: NodeJS.ProcessEnv;
  resolveObserverRegistry: () => Pick<ObserverSessionStore, "resolveObserverScope"> | null;
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
