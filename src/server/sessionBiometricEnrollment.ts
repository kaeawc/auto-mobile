import type {
  BiometricEnrollment,
  DeviceStateResult,
  SetDeviceStateInput,
} from "../features/utility/DeviceState";
import type { SessionManager } from "../daemon/sessionManager";

/** Narrow seam over DeviceState so the merge below is testable without a device. */
export interface DeviceStateSetter {
  setState(input: SetDeviceStateInput): Promise<DeviceStateResult>;
}

/**
 * A failed biometric pre-read must not swallow the other fields of a combined
 * request. Session-scoped `setDeviceState` reads enrollment before mutating so
 * release can restore it; when that read fails there is still nothing stopping
 * the independent Do Not Disturb update, which the sessionless path applies.
 * Apply it here too and report the biometric failure alongside it.
 */
export async function applyStateAfterBiometricCaptureFailure(
  deviceState: DeviceStateSetter,
  input: SetDeviceStateInput,
  failure: DeviceStateResult,
): Promise<DeviceStateResult> {
  if (!input.doNotDisturb) {
    return failure;
  }
  const applied = await deviceState.setState({ doNotDisturb: input.doNotDisturb });
  const errors = [failure.error, applied.error].filter(
    (error): error is string => error !== undefined,
  );
  return {
    ...applied,
    success: false,
    ...(failure.biometrics ? { biometrics: failure.biometrics } : {}),
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

/**
 * Publish a newly captured enrollment state before mutating the simulator, then
 * bind the mutation to the session lifecycle. Release waits for this work before
 * restoring the original state, so a late simctl write cannot leak into a reused
 * simulator.
 */
export async function runSessionBiometricMutation<T>(
  sessionManager: SessionManager | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
  initialEnrollment: BiometricEnrollment | undefined,
  mutation: () => Promise<T>,
): Promise<T> {
  if (!sessionManager || !sessionUuid) {
    return await mutation();
  }
  const session = sessionManager.getSession(sessionUuid);
  if (!session) {
    throw new Error(
      `Cannot mutate biometric enrollment: session ${sessionUuid} is no longer active.`,
    );
  }
  if (session.assignedDevice !== deviceId) {
    throw new Error(
      `Cannot mutate biometric enrollment: session ${sessionUuid} is bound to ${session.assignedDevice}, not ${deviceId}.`,
    );
  }
  if (initialEnrollment) {
    sessionManager.setBiometricEnrollment(sessionUuid, { initialEnrollment });
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
