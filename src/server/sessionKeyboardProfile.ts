import type { SessionManager } from "../daemon/sessionManager";
import { ActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { setKeyboardProfileForTool } from "../features/action/keyboardProfileControl";
import type { KeyboardProfileId } from "../features/action/keyboardProfiles";
import {
  defaultKeyboardProfileRestoreRegistry,
  isKeyboardProfileId,
  restoreKeyboardProfileAfterRelease,
  type KeyboardProfileRestoreRegistry,
} from "../features/action/KeyboardProfileRestore";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

/** The slice of the session manager a tracked keyboard-profile write needs. */
export type SessionKeyboardProfileHost = Pick<
  SessionManager,
  "getSession" | "isAdmittedForAutomation" | "trackSessionSetup"
>;

/**
 * Admit a `keyboard setProfile` write against the session's device and track it as
 * session setup (#14705): release drains tracked setup before its cleanup runs,
 * so a release racing the write restores what the write recorded instead of
 * being overwritten by it. The mutation receives the owning session id;
 * sessionless calls get none.
 */
export async function runSessionKeyboardProfileMutation<T>(
  sessionManager: SessionKeyboardProfileHost | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
  mutation: (owner?: string) => Promise<T>,
): Promise<T> {
  if (!sessionManager || !sessionUuid) {
    return mutation();
  }
  const session = sessionManager.getSession(sessionUuid);
  if (
    !session ||
    !sessionManager.isAdmittedForAutomation(session) ||
    session.assignedDevice !== deviceId
  ) {
    throw new ActionableError(
      "Cannot change the keyboard profile: session is released, releasing, rebound, or replaced.",
    );
  }
  let completed = false;
  let result!: T;
  await sessionManager.trackSessionSetup(session, async () => {
    result = await mutation(session.sessionId);
    completed = true;
  });
  if (!completed) {
    throw new ActionableError(
      "Session began releasing or rebinding before the keyboard profile change started; nothing was changed.",
    );
  }
  return result;
}

export interface SessionKeyboardProfileDependencies {
  sessionManager?: () => SessionKeyboardProfileHost | undefined;
  registry?: KeyboardProfileRestoreRegistry;
  setProfile?: typeof setKeyboardProfileForTool;
  timer?: Pick<Timer, "setTimeout" | "clearTimeout">;
}

/** Whether `sessionId` still holds `deviceId` for automation after an awaited write. */
function stillHoldsDevice(
  sessionManager: SessionKeyboardProfileHost,
  sessionId: string,
  deviceId: string,
): boolean {
  const session = sessionManager.getSession(sessionId);
  return (
    session !== null &&
    sessionManager.isAdmittedForAutomation(session) &&
    session.assignedDevice === deviceId
  );
}

/**
 * Undo a write whose session lost the device mid-write. When the session already
 * owned a restore entry, its release took that entry and restores the profile from
 * before the session's first change; undo to that same profile, not to the
 * intermediate one this write replaced, so the two converge in either order.
 * Bounded like the release restore so a wedged IME lock cannot hold the caller.
 */
async function undoLostOwnershipWrite(
  device: BootedDevice,
  target: string | undefined,
  setProfile: typeof setKeyboardProfileForTool,
  timer: Pick<Timer, "setTimeout" | "clearTimeout">,
): Promise<string> {
  if (target === undefined || !isKeyboardProfileId(target)) {
    return `the previous profile '${target}' is unknown and was not restored`;
  }
  const restored = await restoreKeyboardProfileAfterRelease(
    { device, before: target },
    (restoreDevice, id, restoreSignal) => setProfile(restoreDevice, id, undefined, restoreSignal),
    timer,
  );
  return restored ? `restored '${target}'` : `failed to restore '${target}'`;
}

/**
 * `keyboard setProfile`, recording the profile it replaced (#14705) so a
 * daemon session's release puts it back. Sessionless calls record without an
 * owner and are not restored on release.
 */
export async function setKeyboardProfileForSession(
  device: BootedDevice,
  profile: KeyboardProfileId | undefined,
  sessionUuid: string | undefined,
  deps: SessionKeyboardProfileDependencies = {},
  signal?: AbortSignal,
): Promise<{ activeProfileId?: string; previousProfileId?: string; restoresOnRelease: boolean }> {
  const sessionManager = sessionUuid
    ? (deps.sessionManager ?? (() => defaultDaemonContext.sessionManager()))()
    : undefined;
  const registry = deps.registry ?? defaultKeyboardProfileRestoreRegistry;
  const setProfile = deps.setProfile ?? setKeyboardProfileForTool;
  return runSessionKeyboardProfileMutation(
    sessionManager,
    sessionUuid,
    device.deviceId,
    async (owner) => {
      const ownedTarget = owner ? registry.ownedRestoreTarget(device.deviceId, owner) : undefined;
      const result = await setProfile(device, profile, undefined, signal);
      const before = result.previousProfileId;
      if (owner && sessionManager && !stillHoldsDevice(sessionManager, owner, device.deviceId)) {
        // Release waits for tracked setup only so long; one that outran this write already
        // ran its cleanup without this write's record. Undo the write now.
        const outcome = await undoLostOwnershipWrite(
          device,
          ownedTarget ?? before,
          setProfile,
          deps.timer ?? defaultTimer,
        );
        throw new ActionableError(
          `Session ${owner} was released or rebound while the keyboard profile changed; ${outcome}.`,
        );
      }
      registry.record(device, before, owner);
      return { ...result, restoresOnRelease: registry.restoresOnRelease(device.deviceId) };
    },
  );
}
