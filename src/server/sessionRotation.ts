import type { SessionManager } from "../daemon/sessionManager";
import type { RotationRestoreSlot, RotationRestoreState } from "../features/action/Rotate";
import { ActionableError } from "../models/ActionableError";

/** Admit and track the rotation while Rotate holds its shared per-device lock. */
export async function runSessionRotationMutation<T>(
  manager: SessionManager | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
  mutation: (slot?: RotationRestoreSlot) => Promise<T>,
): Promise<T> {
  if (!manager || !sessionUuid) {
    return mutation();
  }
  const session = manager.getSession(sessionUuid);
  return manager.runRotationMutationExclusive(sessionUuid, async () => {
    if (
      !session ||
      !manager.isAdmittedForAutomation(session) ||
      session.assignedDevice !== deviceId
    ) {
      throw new ActionableError(
        "Cannot change rotation: session is released, releasing, rebound, or replaced.",
      );
    }
    let completed = false;
    let result!: T;
    await manager.trackRotationSessionSetup(session, async (assertCurrentDevice) => {
      let ownedState: RotationRestoreState | undefined;
      result = await mutation({
        get: () => {
          assertCurrentDevice();
          ownedState = session.cacheData.rotation;
          return ownedState;
        },
        record: (value) => {
          assertCurrentDevice();
          manager.setRotation(session, value);
          ownedState = session.cacheData.rotation;
        },
        clear: () => {
          if (ownedState && session.cacheData.rotation === ownedState) {
            delete session.cacheData.rotation;
          }
        },
      });
      completed = true;
    });
    if (!completed) {
      throw new ActionableError("Session began releasing before the rotation mutation started.");
    }
    return result;
  });
}
