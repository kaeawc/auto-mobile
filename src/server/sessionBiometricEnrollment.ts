import type { BiometricEnrollment } from "../features/utility/DeviceState";
import type { SessionManager } from "../daemon/sessionManager";

/**
 * Publish a newly captured enrollment state before mutating the simulator, then
 * bind the mutation to the session lifecycle. Release waits for this work before
 * restoring the original state, so a late simctl write cannot leak into a reused
 * simulator.
 */
export async function runSessionBiometricMutation<T>(
  sessionManager: SessionManager | undefined,
  sessionUuid: string | undefined,
  initialEnrollment: BiometricEnrollment | undefined,
  mutation: () => Promise<T>,
): Promise<T> {
  if (!sessionManager || !sessionUuid) {
    return await mutation();
  }
  if (initialEnrollment) {
    sessionManager.setBiometricEnrollment(sessionUuid, { initialEnrollment });
  }
  const session = sessionManager.getSession(sessionUuid);
  if (!session) {
    throw new Error(
      `Cannot mutate biometric enrollment: session ${sessionUuid} is no longer active.`,
    );
  }

  let completed = false;
  let result!: T;
  await sessionManager.trackSessionSetup(session, async () => {
    result = await mutation();
    completed = true;
  });
  if (!completed) {
    throw new Error(
      `Cannot mutate biometric enrollment: session ${sessionUuid} began releasing before the mutation started.`,
    );
  }
  return result;
}
