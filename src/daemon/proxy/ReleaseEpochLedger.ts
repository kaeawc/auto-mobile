/**
 * Records which session UUIDs the daemon released, and at which release epoch, so an in-flight
 * call that forwarded a UUID can tell whether that exact session was released while it ran and
 * decline to resurrect it (issue #4655). Scoping the record to the UUID, not a global counter, is
 * what lets an unrelated session's release not block remembering the session another in-flight
 * call forwarded.
 *
 * Entries are written only while an in-flight call holds a reference (or an acquisition is
 * running) and are evicted when the last reference drops (#4655 / #5412), so the maps are bounded
 * by the number of concurrently in-flight calls. {@link clearReleaseRecords} is the backstop for a
 * proxy closed with calls still in flight (#4689).
 */
export class ReleaseEpochLedger {
  private epochCounter = 0;
  /** Epoch at which each tracked UUID was last released. */
  readonly releasedSessionEpochs = new Map<string, number>();
  /** Why each tracked UUID was released. */
  readonly releasedSessionReasons = new Map<string, string>();
  /** In-flight calls forwarding each UUID. */
  readonly activeReleaseEpochReferences = new Map<string, number>();
  /** In-flight session-acquiring calls by the epoch they started at. */
  readonly activeAcquisitionReleaseEpochs = new Map<number, number>();

  /** The current release epoch; a call captures it when it forwards. */
  get epoch(): number {
    return this.epochCounter;
  }

  /** Record that the daemon released `sessionUuid`, advancing the global release epoch. */
  recordSessionReleased(sessionUuid: string, reason?: string): void {
    const normalizedSessionUuid = sessionUuid.trim();
    if (normalizedSessionUuid.length === 0) {
      return;
    }
    this.epochCounter += 1;
    if (
      !this.activeReleaseEpochReferences.has(normalizedSessionUuid) &&
      this.activeAcquisitionReleaseEpochs.size === 0
    ) {
      return;
    }
    this.releasedSessionEpochs.set(normalizedSessionUuid, this.epochCounter);
    this.releasedSessionReasons.set(normalizedSessionUuid, reason ?? "released");
  }

  retainReleaseEpochReference(sessionUuid: string | undefined): void {
    if (!sessionUuid) {
      return;
    }
    this.activeReleaseEpochReferences.set(
      sessionUuid,
      (this.activeReleaseEpochReferences.get(sessionUuid) ?? 0) + 1,
    );
  }

  releaseReleaseEpochReference(sessionUuid: string | undefined): void {
    if (!sessionUuid) {
      return;
    }
    const references = (this.activeReleaseEpochReferences.get(sessionUuid) ?? 0) - 1;
    if (references > 0) {
      this.activeReleaseEpochReferences.set(sessionUuid, references);
      return;
    }
    this.activeReleaseEpochReferences.delete(sessionUuid);
    const releasedAtEpoch = this.releasedSessionEpochs.get(sessionUuid);
    if (
      releasedAtEpoch === undefined ||
      !this.isReleaseNeededByActiveAcquisition(releasedAtEpoch)
    ) {
      this.releasedSessionEpochs.delete(sessionUuid);
      this.releasedSessionReasons.delete(sessionUuid);
    }
  }

  retainAcquisitionReleaseEpoch(isSessionAcquisition: boolean, epoch: number): void {
    if (!isSessionAcquisition) {
      return;
    }
    this.activeAcquisitionReleaseEpochs.set(
      epoch,
      (this.activeAcquisitionReleaseEpochs.get(epoch) ?? 0) + 1,
    );
  }

  releaseAcquisitionReleaseEpoch(isSessionAcquisition: boolean, epoch: number): void {
    if (!isSessionAcquisition) {
      return;
    }
    const references = (this.activeAcquisitionReleaseEpochs.get(epoch) ?? 0) - 1;
    if (references > 0) {
      this.activeAcquisitionReleaseEpochs.set(epoch, references);
    } else {
      this.activeAcquisitionReleaseEpochs.delete(epoch);
    }
    for (const [sessionUuid, releasedAtEpoch] of this.releasedSessionEpochs) {
      if (
        !this.activeReleaseEpochReferences.has(sessionUuid) &&
        !this.isReleaseNeededByActiveAcquisition(releasedAtEpoch)
      ) {
        this.releasedSessionEpochs.delete(sessionUuid);
        this.releasedSessionReasons.delete(sessionUuid);
      }
    }
  }

  /** Why `sessionUuid` was released after `forwardEpoch`, or undefined when it was not. */
  sessionReleaseReasonSince(sessionUuid: string, forwardEpoch: number): string | undefined {
    if ((this.releasedSessionEpochs.get(sessionUuid) ?? 0) <= forwardEpoch) {
      return undefined;
    }
    return this.releasedSessionReasons.get(sessionUuid) ?? "released";
  }

  /** Drain the per-UUID records at the close/reconnect boundary. */
  clearReleaseRecords(): void {
    this.releasedSessionEpochs.clear();
    this.releasedSessionReasons.clear();
    this.activeReleaseEpochReferences.clear();
  }

  private isReleaseNeededByActiveAcquisition(releasedAtEpoch: number): boolean {
    for (const acquisitionEpoch of this.activeAcquisitionReleaseEpochs.keys()) {
      if (releasedAtEpoch > acquisitionEpoch) {
        return true;
      }
    }
    return false;
  }
}
