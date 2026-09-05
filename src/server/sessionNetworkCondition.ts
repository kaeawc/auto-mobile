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
  expiresInSeconds?: number,
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
  // Bump the network-condition generation BEFORE mutating (issue #6177): this
  // condition (B) may be applied while an earlier condition's (A's) TTL expiry is
  // still awaiting its restore. Bumping here — and having that expiry re-check the
  // generation it captured when it fired, after its own restore settles — lets a
  // stale A detect it has been superseded and skip clearing B's restore slot.
  sessionManager.bumpNetworkConditionGeneration(sessionUuid);
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

  // Cancel any prior TTL BEFORE the mutation, not after (issue #6085 review): a
  // slow re-apply would otherwise leave the OLD timer armed, and it could fire
  // mid-mutation, reset the just-shaped device, and clear the freshly-published
  // restore slot. Cancelling up front closes that overlap window; the new TTL (if
  // any) is armed only after the mutation settles, below.
  sessionManager.cancelNetworkConditionExpiry(sessionUuid);

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
  // Arm the standalone per-condition TTL (issue #6085 item 2) for a degrade that
  // registered a restore slot AND carries a positive TTL. Pass the CAPTURED
  // `session` instance so a stale re-apply — one whose tracked setup finished only
  // after this session was released and replaced under the same UUID — cannot arm
  // a TTL against the replacement (scheduleNetworkConditionExpiry identity-guards
  // on it). A reset, or a degrade with no TTL, arms nothing; the pre-mutation
  // cancel above already cleared any prior timer.
  if (registerRestore && expiresInSeconds !== undefined && expiresInSeconds > 0) {
    sessionManager.scheduleNetworkConditionExpiry(session, expiresInSeconds);
  }
  return result;
}
