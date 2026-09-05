import type { SessionManager } from "../daemon/sessionManager";

/**
 * True when `value` shows the network-condition mutation itself did not
 * succeed — a typed failure (`DeviceState` converts a failed emulator command
 * into a resolved result rather than throwing) rather than a thrown error or
 * an untyped void return.
 *
 * A combined `setDeviceState` request (e.g. `networkCondition` + `doNotDisturb`
 * in one call) can report a `success: false` TOP-LEVEL aggregate because a
 * DIFFERENT field failed while `networkCondition` itself applied cleanly
 * (issue #6178 PR #6183 review, P2): re-arming the prior TTL on that aggregate
 * flag would wrongly revive a deadline the network mutation already retired.
 * So when a `networkCondition` sub-result is present, judge success from IT
 * specifically, using the same predicate `DeviceState.setState` folds into its
 * own aggregate (`supported && !error && verified !== false`) — never the
 * top-level flag. Only a result with no `networkCondition` sub-result (a bare
 * reset outcome with no per-field breakdown) falls back to the top-level flag.
 */
function isTypedFailureResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if ("networkCondition" in record && typeof record.networkCondition === "object") {
    const networkCondition = record.networkCondition as Record<string, unknown> | null;
    if (networkCondition !== null) {
      const succeeded =
        networkCondition.supported === true &&
        !networkCondition.error &&
        networkCondition.verified !== false;
      return !succeeded;
    }
  }
  return "success" in record && record.success === false;
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
  // Run the ENTIRE apply/reset + TTL decision as one per-session critical
  // section (issue #6178 PR #6183 review, structural fix): the generation
  // guard on `rearmNetworkConditionExpiry` alone cannot preserve a displaced
  // expiry, because a later generation only proves a mutation was ATTEMPTED,
  // not that it succeeded — two overlapping FAILURES (a slow B, then C) could
  // each find nothing to restore while a timed degrade's (A's) original
  // deadline is lost between them. Serializing here removes that whole
  // interleaving family: at most one such critical section runs per session at
  // a time, so this mutation's snapshot always sees the FULLY SETTLED state
  // (including any earlier mutation's own re-arm) rather than a window where
  // it has been cancelled but not yet resolved one way or the other.
  return sessionManager.runNetworkConditionMutationExclusive(sessionUuid, async () => {
    // Bump the network-condition generation BEFORE mutating (issue #6177), and
    // CAPTURE the value THIS mutation was assigned into a local. This condition
    // (B) may be applied while an earlier condition's (A's) TTL expiry is still
    // awaiting its restore — bumping here, and having that expiry re-check the
    // generation it captured when it fired, lets a stale A detect it has been
    // superseded and skip clearing B's restore slot. The generation guard now
    // serves as defense-in-depth alongside the serialization above, not as the
    // sole protection.
    //
    // The capture matters as much as the bump (issue #6181 review): a caller
    // must be told THIS call's generation explicitly rather than re-reading
    // "current" once the mutation settles — by then a later queued mutation may
    // have bumped it further, and re-reading would mistag this TTL with a
    // generation it doesn't own.
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
      // Restore the prior deadline and STOP (issue #6178 PR #6183 review, P2): a
      // failed re-apply must not fall through to the schedule below, which would
      // immediately cancel the just-restored timer and arm a fresh TTL for a
      // mutation that never actually took effect.
      rearmPriorExpiry();
      return result;
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
  });
}
