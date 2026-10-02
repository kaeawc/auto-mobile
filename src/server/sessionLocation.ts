import type { SessionManager, Session } from "../daemon/sessionManager";
import { ActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import {
  defaultMockLocationClearRegistry,
  type MockLocationClears,
} from "../features/utility/MockLocationClear";

interface SessionLocationScope {
  sessionManager?: SessionManager;
  sessionUuid?: string;
  deviceId: string;
}

/** Attribution requires the captured identity to remain live, admitted, and bound. */
export function getLiveSessionLocationWrite(
  options: SessionLocationScope & {
    sessionManager: SessionManager;
    sessionUuid: string;
    session: Session;
  },
) {
  const { sessionManager, sessionUuid, deviceId, session } = options;
  return sessionManager.getSession(sessionUuid) === session &&
    sessionManager.isAdmittedForAutomation(session) &&
    session.assignedDevice === deviceId
    ? session
    : null;
}

/** Only the handler's live session scope owns automatic simulator cleanup. */
export function createSessionLocationAppliedCallback(
  options: Omit<SessionLocationScope, "deviceId"> & {
    device: BootedDevice;
    mockLocationClears?: MockLocationClears;
  },
): (() => void) | undefined {
  const { sessionManager, sessionUuid } = options;
  if (!sessionManager || !sessionUuid) {
    return undefined;
  }
  const session = sessionManager.getSession(sessionUuid);
  if (!session) {
    return undefined;
  }
  const scope = {
    ...options,
    sessionManager,
    sessionUuid,
    session,
    deviceId: options.device.deviceId,
  };
  // Remember initial eligibility solely for a write that outlives release/unbind.
  // Ordinary ownership is decided at apply time, including newly admitted sessions.
  const admittedAtConstruction = getLiveSessionLocationWrite(scope) === session;
  const registry = options.mockLocationClears ?? defaultMockLocationClearRegistry;
  return () => {
    if (getLiveSessionLocationWrite(scope) === session) {
      registry.markSet(session.sessionId, options.device);
      return;
    }
    const releasedOrUnbound =
      sessionManager.getSession(sessionUuid) !== session ||
      session.assignedDevice !== options.device.deviceId ||
      sessionManager.getReleasingSession(sessionUuid) === session;
    if (!admittedAtConstruction || !releasedOrUnbound) {
      return;
    }
    // Setup drain is bounded: a successful late set can follow its lifecycle hook.
    // Publish its clear before setup settles, extending the existing quarantine.
    const clear = registry.clearLateSet({ sessionId: session.sessionId, device: options.device });
    if (clear) {
      sessionManager.registerPendingDeviceCleanup(options.device.deviceId, clear);
    }
  };
}

/** Retain the session identity so a late write cannot borrow a replacement's admission. */
export function createSessionLocationWriteAdmission(options: SessionLocationScope): () => boolean {
  const { sessionManager, sessionUuid, deviceId } = options;
  if (!sessionManager || !sessionUuid) {
    return () => true;
  }
  const session = sessionManager.getSession(sessionUuid);
  return () =>
    !!session &&
    sessionManager.isAdmittedForAutomation(session) &&
    session.assignedDevice === deviceId;
}

/** Admit location writes against the resolved device before tracking their setup. */
export async function runSessionLocationMutation<T>(
  options: SessionLocationScope & {
    mutation: () => Promise<T>;
  },
): Promise<T> {
  const { sessionManager, sessionUuid, deviceId, mutation } = options;
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
      "Cannot change location: session is released, releasing, rebound, or replaced.",
    );
  }
  let completed = false;
  let result!: T;
  await sessionManager.trackSessionSetup(session, async () => {
    result = await mutation();
    completed = true;
  });
  if (!completed) {
    throw new ActionableError(
      "Session began releasing or rebinding before the location mutation started.",
    );
  }
  return result;
}
