import type { SessionManager } from "../daemon/sessionManager";

/**
 * True when `value` is a typed `{ success: false, ... }` result (e.g.
 * `DeviceStateResult`) rather than a thrown error or an untyped void return.
 * `DeviceState` converts a failed emulator command into a resolved
 * `success: false` rather than throwing (issue #6178 item 1), so a caller
 * that only watches for a rejection misses it.
 */
function isTypedFailureResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    (value as Record<string, unknown>).success === false
  );
}

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
  // Bump the network-condition generation BEFORE mutating (issue #6177), and
  // CAPTURE the value THIS mutation was assigned into a local. This condition
  // (B) may be applied while an earlier condition's (A's) TTL expiry is still
  // awaiting its restore — bumping here, and having that expiry re-check the
  // generation it captured when it fired, lets a stale A detect it has been
  // superseded and skip clearing B's restore slot.
  //
  // The capture matters as much as the bump (issue #6181 review): two mutations
  // (B, C) can each bump the shared counter before either reaches the `await
  // trackSessionSetup` below, so `scheduleNetworkConditionExpiry` must be told
  // THIS call's generation explicitly rather than re-reading "current" once the
  // mutation settles — by then a third mutation may have bumped it further, and
  // re-reading would mistag this TTL with a generation it doesn't own.
  const generation = sessionManager.bumpNetworkConditionGeneration(sessionUuid);
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
  //
  // Snapshot the prior TTL's DEADLINE before cancelling it (issue #6178 item 1):
  // if this mutation is a manual reset (or any mutation) that does not confirm
  // success — a typed `success: false` result, or a thrown error — the
  // emulator's shaping never actually changed, so the ORIGINAL deadline must
  // survive rather than being silently dropped. Re-arming below restores that
  // deadline, but tagged with THIS call's generation (captured above), not the
  // snapshot's: the counter was already bumped for this attempt regardless of
  // its outcome, so the re-armed timer must match what
  // `currentNetworkConditionGeneration` will return, or its eventual successful
  // fire would see a generation mismatch and skip clearing the restore slot.
  const priorExpiry = sessionManager.peekNetworkConditionExpiry(sessionUuid);
  sessionManager.cancelNetworkConditionExpiry(sessionUuid);
  const rearmPriorExpiry = () => {
    if (priorExpiry) {
      sessionManager.rearmNetworkConditionExpiry(session, {
        deadlineMs: priorExpiry.deadlineMs,
        generation,
      });
    }
  };

  let completed = false;
  let result!: T;
  try {
    await sessionManager.trackSessionSetup(session, async () => {
      result = await mutation();
      completed = true;
    });
  } catch (error) {
    rearmPriorExpiry();
    throw error;
  }
  if (!completed) {
    rearmPriorExpiry();
    throw new Error(
      `Cannot mutate network condition: session ${sessionUuid} began releasing before the mutation started.`,
    );
  }
  if (isTypedFailureResult(result)) {
    rearmPriorExpiry();
  }
  // Arm the standalone per-condition TTL (issue #6085 item 2) for a degrade that
  // registered a restore slot AND carries a positive TTL. Pass the CAPTURED
  // `session` instance so a stale re-apply — one whose tracked setup finished only
  // after this session was released and replaced under the same UUID — cannot arm
  // a TTL against the replacement (scheduleNetworkConditionExpiry identity-guards
  // on it). A reset, or a degrade with no TTL, arms nothing; the pre-mutation
  // cancel above already cleared any prior timer.
  if (registerRestore && expiresInSeconds !== undefined && expiresInSeconds > 0) {
    sessionManager.scheduleNetworkConditionExpiry(session, expiresInSeconds, generation);
  }
  return result;
}
