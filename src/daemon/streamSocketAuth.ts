import { InputDeviceOwnedError } from "./inputDeviceOwnership";
import { SessionNoLongerOwnsDeviceError } from "../models/sessionNoLongerOwnsDevice";
import type { ObserverSessionStore } from "./observerSessionRegistry";
import { defaultDaemonContext } from "./daemonContext";
import {
  SessionScopedStreamAuthenticator,
  STREAM_SOCKET_AUTH_ENV,
  type StreamSocketAuthenticator,
  type StreamAuthorizeInput,
  type StreamAuthSessionManager,
} from "./SessionScopedStreamAuthenticator";

/** Check the device selected by discovery before starting device-side work. */
export function authorizeResolvedDevice(
  authenticator: StreamSocketAuthenticator,
  options: StreamAuthorizeInput & { deviceId: string },
): void {
  authenticator.authorize(options);
}

/** Only ownership refusals from stream authorization are exposed on auxiliary response frames. */
export function streamAuthRefusalFields(error: unknown):
  | {
      code: InputDeviceOwnedError["code"] | SessionNoLongerOwnsDeviceError["code"];
      retryable: boolean;
      deviceId: string;
      retryAfterMs?: number;
    }
  | {} {
  if (error instanceof InputDeviceOwnedError || error instanceof SessionNoLongerOwnsDeviceError) {
    return {
      code: error.code,
      retryable: error.retryable,
      deviceId: error.deviceId,
      ...(error instanceof InputDeviceOwnedError && typeof error.retryAfterMs === "number"
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    };
  }
  return {};
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
  const resolveSessionManager = () => defaultDaemonContext.sessionManager() ?? null;
  if (options.allowObserverSessions) {
    return new ObserverAdmittingStreamAuthenticator({
      resolveSessionManager,
      operation,
      resolveObserverRegistry: () => defaultDaemonContext.observerSessionRegistry() ?? null,
    });
  }
  return new SessionScopedStreamAuthenticator(resolveSessionManager, operation);
}

export { SessionScopedStreamAuthenticator } from "./SessionScopedStreamAuthenticator";

export { type StreamSocketAuthenticator } from "./SessionScopedStreamAuthenticator";

export { type StreamAuthSessionManager } from "./SessionScopedStreamAuthenticator";

export { type StreamAuthorizeInput } from "./SessionScopedStreamAuthenticator";

export { STREAM_SOCKET_AUTH_ENV } from "./SessionScopedStreamAuthenticator";
