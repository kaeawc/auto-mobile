import type { SessionManager } from "../daemon/sessionManager";

/**
 * Bind a device-wide network-condition mutation to the session lifecycle,
 * paralleling {@link runSessionBiometricMutation} (issue #6012 review).
 *
 * A network-only `setDeviceState` request does not go through the biometric
 * capture path, so without this it would run UNTRACKED: a release or rebind
 * racing the emulator command could restore `none` first and then the late
 * `network delay`/`speed` command would re-shape a freed device. Registering the
 * restore slot *before* the mutation, then running the mutation inside
 * `trackSessionSetup`, closes that window — release waits for the tracked
 * mutation, and the slot it sees guarantees the device is restored afterwards.
 *
 * When there is no session (direct/sessionless mode) it simply runs the mutation.
 */
export async function runSessionNetworkMutation<T>(
  sessionManager: SessionManager | undefined,
  sessionUuid: string | undefined,
  deviceId: string,
  registerRestore: boolean,
  mutation: () => Promise<T>,
): Promise<T> {
  if (!sessionManager || !sessionUuid) {
    return await mutation();
  }
  const session = sessionManager.getSession(sessionUuid);
  if (!session) {
    throw new Error(`Cannot mutate network condition: session ${sessionUuid} is no longer active.`);
  }
  if (session.assignedDevice !== deviceId) {
    throw new Error(
      `Cannot mutate network condition: session ${sessionUuid} is bound to ${session.assignedDevice}, not ${deviceId}.`,
    );
  }
  // Publish the restore slot before mutating, so a release that begins while the
  // emulator command is in flight already knows the device must be restored.
  //
  // DOCUMENTED CONTRACT (issue #6012): a session ALWAYS restores the network to a
  // clean `none` state on release/rebind — never to a reconstructed pre-session
  // condition. This is deliberate, not a limitation to paper over: the emulator
  // console's `network status` returns only free-form download/upload/latency
  // text whose format varies by emulator version, so a pre-session baseline
  // cannot be reliably reconstructed or re-applied — and faking one would be
  // worse than not trying. More importantly, sessions run against a device pool
  // that must hand the NEXT session a clean device, so restoring to `none` is the
  // correct behavior even if a prior condition were knowable. The stored baseline
  // is therefore fixed at `none`.
  if (registerRestore) {
    sessionManager.setNetworkCondition(sessionUuid, { initialProfile: "none" });
  }

  let completed = false;
  let result!: T;
  await sessionManager.trackSessionSetup(session, async () => {
    result = await mutation();
    completed = true;
  });
  if (!completed) {
    throw new Error(
      `Cannot mutate network condition: session ${sessionUuid} began releasing before the mutation started.`,
    );
  }
  return result;
}
