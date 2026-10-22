import type { Session, SessionManager } from "../daemon/sessionManager";
import { startPowerRestore, type PowerSessionCleanupOptions } from "../daemon/powerSessionCleanup";
import type { PowerMutation } from "../features/utility/power/PowerOperations";
import { defaultPowerRegistry } from "../features/utility/power/PowerRegistry";
import { ActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";

/** The session fields the wrapper reads. */
interface PowerSessionView {
  sessionId: string;
  assignedDevice: string;
}

/** The slice of the session manager a tracked power write needs (`SessionManager` fits). */
export interface SessionPowerHost<S extends PowerSessionView = Session> extends Pick<
  SessionManager,
  "registerPendingDeviceCleanup"
> {
  getSession(sessionId: string): S | null;
  isAdmittedForAutomation(session: S): boolean;
  trackSessionSetup(session: S, createSetup: () => Promise<void>): Promise<void>;
}

function isLiveOn<S extends PowerSessionView>(
  host: SessionPowerHost<S>,
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
 * The `setDeviceState.power` write wrapper for a session (#14084): admit the write against the
 * session's device, track it as session setup (release drains tracked setup before its cleanup
 * runs) and hand the write the owning session id, so what it changes is recorded for that session
 * and restored on its release. Sessionless calls get no owner. A write that completes after the
 * session was released or rebound anyway (the setup drain is bounded) is restored at once.
 */
export function createSessionPowerMutation<S extends PowerSessionView>(
  host: SessionPowerHost<S> | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
  options: PowerSessionCleanupOptions = {},
): PowerMutation {
  return async (mutation) => {
    if (!host || !sessionUuid) {
      return mutation(undefined);
    }
    const session = host.getSession(sessionUuid);
    if (!session || !isLiveOn(host, sessionUuid, session, deviceId)) {
      throw new ActionableError(
        "Cannot change power state: session is released, releasing, rebound, or replaced.",
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
        "Session began releasing or rebinding before the power change started; nothing was changed.",
      );
    }
    const late = isLiveOn(host, sessionUuid, session, deviceId)
      ? undefined
      : (options.registry ?? defaultPowerRegistry).takeOwnedBy(deviceId, session.sessionId);
    if (late) {
      logger.warn(
        `[power] Session ${session.sessionId} ended while changing power state on ${deviceId}; restoring it`,
      );
      void startPowerRestore(host, late, options);
      return {
        ...result,
        restoreOnRelease: false,
        warning: "The session ended during the change; the power state is being restored.",
      };
    }
    return result;
  };
}
