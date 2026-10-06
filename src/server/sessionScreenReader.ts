import type { SessionManager } from "../daemon/sessionManager";
import type {
  ScreenReaderRestoreSlot,
  ScreenReaderRestoreState,
} from "../features/accessibility/ScreenReaderRestore";
import { ActionableError } from "../models/ActionableError";

/**
 * Admit and track a screen-reader toggle so release restores what the session
 * found (#10146). Mirrors `runSessionRotationMutation`: the slot is recorded
 * before the toggle writes anything, and release drains the tracked toggle first.
 */
export async function runSessionScreenReaderMutation<T>(
  manager: SessionManager | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
  mutation: (slot?: ScreenReaderRestoreSlot) => Promise<T>,
): Promise<T> {
  if (!manager || !sessionUuid) {
    return mutation();
  }
  const session = manager.getSession(sessionUuid);
  return manager.runScreenReaderMutationExclusive(sessionUuid, async () => {
    if (
      !session ||
      !manager.isAdmittedForAutomation(session) ||
      session.assignedDevice !== deviceId
    ) {
      throw new ActionableError(
        "Cannot change the screen reader: session is released, releasing, rebound, or replaced.",
      );
    }
    let completed = false;
    let result!: T;
    await manager.trackScreenReaderSessionSetup(session, async (assertCurrentDevice) => {
      let ownedState: ScreenReaderRestoreState | undefined;
      result = await mutation({
        get: () => {
          assertCurrentDevice();
          ownedState = session.cacheData.screenReader;
          return ownedState;
        },
        record: (value) => {
          assertCurrentDevice();
          manager.setScreenReader(session, value);
          ownedState = session.cacheData.screenReader;
        },
        clear: () => {
          if (ownedState && session.cacheData.screenReader === ownedState) {
            delete session.cacheData.screenReader;
          }
        },
      });
      completed = true;
    });
    if (!completed) {
      throw new ActionableError(
        "Session began releasing before the screen reader mutation started.",
      );
    }
    return result;
  });
}
