import type { SessionManager } from "../daemon/sessionManager";
import type { DeviceClockRestoreSlot } from "../features/utility/DeviceClock";
import { ActionableError } from "../models/ActionableError";

/** Serialize clock writes and bind their original auto_time to the existing setup/release lifecycle. */
export async function runSessionClockMutation<T>(
  manager: SessionManager | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
  mutation: (slot?: DeviceClockRestoreSlot) => Promise<T>,
): Promise<T> {
  if (!manager || !sessionUuid) {
    return mutation();
  }
  const session = manager.getSession(sessionUuid);
  return manager.runClockMutationExclusive(sessionUuid, async () => {
    if (
      !session ||
      !manager.isAdmittedForAutomation(session) ||
      session.assignedDevice !== deviceId
    ) {
      throw new ActionableError(
        "Cannot change clock: session is released, releasing, rebound, or replaced.",
      );
    }
    let completed = false;
    let result!: T;
    await manager.trackSessionSetup(session, async () => {
      result = await mutation({
        get: () => session.cacheData.clock,
        record: (value) => {
          manager.setClock(session, value);
        },
        clear: () => {
          delete session.cacheData.clock;
        },
      });
      completed = true;
    });
    if (!completed) {
      throw new ActionableError("Session began releasing before the clock mutation started.");
    }
    return result;
  });
}
