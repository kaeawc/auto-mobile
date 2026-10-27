import type { Session, SessionManager } from "../daemon/sessionManager";
import {
  startScreenLockRestore,
  type ScreenLockSessionCleanupOptions,
} from "../daemon/screenLockSessionCleanup";
import { defaultScreenLockRegistry } from "../features/utility/screenLock/ScreenLockRegistry";
import type { ScreenLockMutation } from "../features/utility/screenLock/ScreenLockOperations";
import { ActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";

/** The session fields the wrapper reads. */
interface ScreenLockSessionView {
  sessionId: string;
  assignedDevice: string;
}

/** The slice of the session manager a tracked screen-lock write needs (`SessionManager` fits). */
export interface SessionScreenLockHost<S extends ScreenLockSessionView = Session> extends Pick<
  SessionManager,
  "registerPendingDeviceCleanup"
> {
  getSession(sessionId: string): S | null;
  isAdmittedForAutomation(session: S): boolean;
  trackSessionSetup(session: S, createSetup: () => Promise<void>): Promise<void>;
}

function isLiveOn<S extends ScreenLockSessionView>(
  host: SessionScreenLockHost<S>,
  sessionUuid: string,
  session: S,
  deviceId: string,
): boolean {
  return (
    host.getSession(sessionUuid) === session &&
    host.isAdmittedForAutomation(session) &&
    session.assignedDevice === deviceId
  );
}

/**
 * The `setDeviceState.screenLock` write wrapper for a session (#14107): admit the write against
 * the session's device, track it as session setup (release drains tracked setup before its
 * cleanup runs) and hand the write the owning session id, so the credential is recorded for that
 * session and cleared on its release. Sessionless calls get no owner. A set that completes after
 * the session was released or rebound anyway (the setup drain is bounded) is cleared at once.
 */
export function createSessionScreenLockMutation<S extends ScreenLockSessionView>(
  host: SessionScreenLockHost<S> | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
  options: ScreenLockSessionCleanupOptions = {},
): ScreenLockMutation {
  return async (mutation) => {
    if (!host || !sessionUuid) {
      return mutation(undefined);
    }
    const session = host.getSession(sessionUuid);
    if (!session || !isLiveOn(host, sessionUuid, session, deviceId)) {
      throw new ActionableError(
        "Cannot change the screen lock: session is released, releasing, rebound, or replaced.",
      );
    }
    let completed = false;
    let result!: Awaited<ReturnType<typeof mutation>>;
    await host.trackSessionSetup(session, async () => {
      result = await mutation(session.sessionId);
      completed = true;
    });
    if (!completed) {
      throw new ActionableError(
        "Session began releasing or rebinding before the screen lock change started; nothing was changed.",
      );
    }
    const late = isLiveOn(host, sessionUuid, session, deviceId)
      ? undefined
      : (options.registry ?? defaultScreenLockRegistry).takeOwnedBy(deviceId, session.sessionId);
    if (late) {
      logger.warn(
        `[screenLock] Session ${session.sessionId} ended while setting a lock on ${deviceId}; clearing it`,
      );
      void startScreenLockRestore(host, late, options);
      return {
        ...result,
        restoreOnRelease: false,
        warning: "The session ended during the change; the lock is being cleared.",
      };
    }
    return result;
  };
}
